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
  // 한 문장에 서로 다른 장소가 각각 언급된 경우("HJNC 앞 해역 … PNC 3번 선석")는 들린 그대로 둔다.
  // [A / B] 는 같은 자리의 값이 엇갈릴 때(원음/완화음 불일치, 정정 불명확)만 쓴다.
  if (u.reason === 'MULTIPLE_CANDIDATES') return null;
  if (field === 'vessel') {
    // 선박은 한 문장에 여러 척이 나온다. 이 이름이 다른 쪽 인식에도 들렸으면 확실한 것으로 보고,
    // 한쪽에만 들린 이름만 [이 이름 / 다른 쪽에만 들린 이름] 으로 표시한다 ("제7해진호" vs "칠레진호")
    const other = c.source === 'enhanced' ? 'raw' : 'enhanced';
    const otherNames = result.candidates.filter((x) => x.field === 'vessel' && x.source === other).map((x) => x.value);
    if (otherNames.length === 0 || otherNames.includes(c.value)) return null;
    const mine = result.candidates.filter((x) => x.field === 'vessel' && x.source === c.source).map((x) => x.value);
    const onlyOther = otherNames.filter((n) => !mine.includes(n));
    return onlyOther.length ? `[${[c.value, ...onlyOther].join(' / ')}]` : `[${c.value}?]`;
  }
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
    const normalized = c.field === 'time' || c.field === 'distance' || c.field === 'identifier' || c.field === 'berth' ? c.value.replace(/^(d+(?:.d+)?)mile$/, '$1 mi') : c.surface;
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

/**
 * 참고 번역용 절 나누기. 작은 MT 모델은 긴 문장의 뒷부분을 버리므로 마침표·쉼표·연결어미 단위로 자른다.
 * 실측: "…감속하시고 좌현 대 좌현으로 통과하십시오" → "Slow to eight knots and pass port to port."
 */
export function splitClauses(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+|(?<=(?:니|며|고)),?\s+(?=[^\s])|,\s+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 참고 번역에 보호 값(영문·숫자 코드)이 그대로 남았는지 검사. 한글 선박명은 음역되므로 검사하지 않는다 */
export function missingValues(translated: string, tokens: ProtectedToken[]): string[] {
  const up = translated.toUpperCase().replace(/\s+/g, '');
  const issues: string[] = [];
  for (const t of tokens) {
    const codes = (t.value.match(/[A-Za-z]{2,}\d*|\d+/g) ?? []).map((c) => c.toUpperCase());
    for (const c of codes) if (!up.includes(c)) issues.push(`보호 정보 누락: ${c}`);
  }
  return [...new Set(issues)];
}
