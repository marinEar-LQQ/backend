import type { AnalysisResult, EntityCandidate, ProtectedToken } from '../../contracts';

/**
 * 번역 보호 (백엔드 06장): 선박명·터미널·선석·시간·거리·식별번호를 placeholder 로 바꿔 번역하고,
 * 번역 후 복원·개수 검증한다. 원문이 불확실하면 [PNIT / HPNT] 처럼 대안을 그대로 보존한다.
 */

const PROTECTED_FIELDS = new Set(['vessel', 'terminal', 'berth', 'time', 'distance', 'identifier']);

export interface ProtectedSource {
  /** 사람이 읽는 한국어 원문 (불확실 값은 [A / B] 로 표시) */
  displayText: string;
  /** placeholder 가 들어간 번역 입력 */
  protectedText: string;
  tokens: ProtectedToken[];
}

export function placeholder(i: number): string {
  return `[${i + 1}]`;
}

function uncertainDisplay(result: AnalysisResult, c: EntityCandidate): string | null {
  const field = c.field === 'terminal' ? 'terminalId' : c.field === 'berth' ? 'berthId' : c.field === 'vessel' ? 'vessel' : null;
  if (!field) return null;
  const u = result.uncertainties.find((x) => x.field === field);
  if (!u || u.alternatives.length === 0) return null;
  return u.alternatives.length === 1 ? `[${u.alternatives[0]}?]` : `[${u.alternatives.join(' / ')}]`;
}

/** 번역 원문은 enhanced 전사(없으면 raw) */
export function buildProtectedSource(result: AnalysisResult): ProtectedSource {
  const transcript = result.enhancedTranscript ?? result.rawTranscript;
  const source = result.enhancedTranscript ? 'enhanced' : 'raw';
  const text = transcript?.text ?? '';
  const cands = result.candidates
    .filter((c) => c.source === source && PROTECTED_FIELDS.has(c.field))
    .sort((a, b) => a.span.start - b.span.start);

  const tokens: ProtectedToken[] = [];
  let display = '';
  let prot = '';
  let cursor = 0;
  for (const c of cands) {
    if (c.span.start < cursor) continue;
    const before = text.slice(cursor, c.span.start);
    const uncertain = uncertainDisplay(result, c);
    // 시간·거리·번호는 번역문에서 언어와 무관하게 읽히도록 정규화 값(14:30, 1.5NM)으로 복원
    const normalized = c.field === 'time' || c.field === 'distance' || c.field === 'identifier' ? c.value : c.surface;
    const value = uncertain ?? normalized;
    const ph = placeholder(tokens.length);
    tokens.push({ placeholder: ph, value, field: uncertain ? 'uncertain' : c.field });
    display += before + (uncertain ?? c.surface);
    prot += before + ph;
    cursor = c.span.end;
  }
  display += text.slice(cursor);
  prot += text.slice(cursor);
  return { displayText: display, protectedText: prot, tokens };
}

export interface RestoreResult {
  text: string;
  ok: boolean;
  issues: string[];
}

/** placeholder 복원 + 개수/값 검증. 누락·중복·변형이면 ok=false (값을 새로 만들지 않음) */
export function restoreTokens(translated: string, tokens: ProtectedToken[]): RestoreResult {
  const issues: string[] = [];
  let text = translated;
  for (const t of tokens) {
    const count = text.split(t.placeholder).length - 1;
    if (count === 0) issues.push(`보호 정보 누락: ${t.value}`);
    else if (count > 1) issues.push(`보호 정보 중복: ${t.value}`);
  }
  const unknown = (text.match(/\[\d+\]/g) ?? []).filter((p) => !tokens.some((t) => t.placeholder === p));
  if (unknown.length > 0) issues.push(`알 수 없는 placeholder: ${unknown.join(', ')}`);
  // 긴 번호부터 복원 ([10] 이 [1] 로 잘못 치환되지 않게)
  for (const t of [...tokens].sort((a, b) => b.placeholder.length - a.placeholder.length)) {
    text = text.split(t.placeholder).join(t.value);
  }
  return { text, ok: issues.length === 0, issues };
}
