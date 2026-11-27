import type { CatalogManifest, EntityCandidate, EntityField, Transcript, TranscriptSource } from '../../contracts';

/**
 * EntityResolver — 한국어 교신 문장에서 선박·터미널·선석·시간·거리·식별번호·변경 의도 후보를 뽑는다.
 * 원칙 (백엔드 03장):
 *  - 값 + 근거(span, 추출 방법)를 함께 반환한다.
 *  - 숫자만 있고 유형(시간·거리·선석)을 구분할 근거가 없으면 유형을 추정하지 않는다.
 *  - 발음이 비슷하다는 이유로 다른 터미널로 강제 보정하지 않는다 (별칭 사전에 있는 표현만 연결).
 */

export interface ExtractionOutput {
  candidates: EntityCandidate[];
  /** 정정·부정어 뒤에 대체 값이 없어 최종 의미가 불명확한 필드 */
  correctionUnclear: EntityField[];
  /** 유형 근거 없는 숫자 (선석·시간·거리로 추정하지 않음) */
  bareNumbers: string[];
}

const LATIN_LETTER_NAMES: Record<string, string> = {
  에이: 'A', 비: 'B', 씨: 'C', 디: 'D', 에프: 'F', 에이치: 'H',
};

const VESSEL_STOP_NAMES = new Set([
  '번', '신', '기', '부', '전화번', '호', '모든', '각', '본', '해당', '통항', '입항', '출항', '대형', '소형',
  '다른', '상대', '예인', '그', '이', '저', '일반', '작업', '관련', '외국', '국적', '어', '화물', '여객',
  // 일반 낱말 (상호=서로, 선호, 보호, 구호, 경호, 수호, 비호, 환호, 기호, 괄호, 암호, 애호)
  '상', '선', '보', '구', '경', '수', '환', '괄', '암', '애',
]);

const PARTICLE_AFTER = '(?=$|[\\s,.!?·~]|은|는|이|가|을|를|에|의|로|으로|도|와|과|께|랑|야|님|측)';
const CORRECTION_AFTER = /^\s*(?:이|가|은|는)?\s*(?:말고|아니고|아니라|아니야|아닙니다|아님|대신|취소)/;
const CORRECTION_BETWEEN = /정정|말고|아니고|아니라|대신|취소/;
const CHANGE_KEYWORDS = /변경|바꿔|바꾸|바뀌|바뀝|이동|옮겨|옮기|대신|말고|정정|아니고|아니라/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 별칭 → 띄어쓰기·점·하이픈이 끼어도 맞는 정규식 조각 ("P N I T", "P.N.I.T") */
function aliasPattern(alias: string): string {
  return Array.from(alias.replace(/\s+/g, ''))
    .map(escapeRe)
    .join('[\\s.\\-·]*');
}

interface Hit {
  field: EntityField;
  value: string;
  start: number;
  end: number;
  method: EntityCandidate['method'];
}

function overlaps(hits: Hit[], start: number, end: number): boolean {
  return hits.some((h) => start < h.end && end > h.start);
}

export function normalizeVesselName(raw: string): string {
  const compact = raw.replace(/\s+/g, '');
  const m = compact.match(/^(.*?)(선박|호|號)$/);
  const core = m ? m[1]! : compact;
  const suffix = m ? (m[2] === '號' ? '호' : m[2]!) : '';
  const latinCore = LATIN_LETTER_NAMES[core] ?? core;
  return (latinCore.toUpperCase() + suffix).trim();
}

/** 선박 동일성 비교용 핵심 이름 (접미사 호/선박 제거) */
export function vesselCore(name: string): string {
  return normalizeVesselName(name).replace(/(선박|호)$/, '');
}

function segmentIdFor(transcript: Transcript, surface: string): string | null {
  const seg = transcript.segments.find((s) => s.text.includes(surface));
  return seg ? seg.segmentId : null;
}

export function extractCandidates(
  transcript: Transcript,
  source: TranscriptSource,
  catalog: CatalogManifest,
  knownVessels: string[] = [],
): ExtractionOutput {
  const text = transcript.text;
  const hits: Hit[] = [];

  // 1) 터미널: 카탈로그 별칭 (긴 별칭 우선)
  const aliasList = catalog.terminals
    .flatMap((t) => t.aliases.map((a) => ({ alias: a, terminalId: t.terminalId })))
    .sort((a, b) => b.alias.length - a.alias.length);
  for (const { alias, terminalId } of aliasList) {
    const re = new RegExp(`(?<![A-Za-z])${aliasPattern(alias)}(?![A-Za-z])`, 'giu');
    for (const m of text.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (!overlaps(hits, start, end)) hits.push({ field: 'terminal', value: terminalId, start, end, method: 'catalog-alias' });
    }
  }

  // 2) 선석: T3 / 티3 / 티쓰리 / 3번 선석 — 유형 근거가 있는 표현만
  const berthWords: Record<string, number> = { 원: 1, 투: 2, 쓰리: 3, 포: 4, 파이브: 5 };
  const berthPatterns: Array<[RegExp, (m: RegExpMatchArray) => number]> = [
    [/(?<![A-Za-z0-9가-힣])(?:T|티)[\s\-]*(\d{1,2})(?!\d)/giu, (m) => Number(m[1])],
    [/(?<![A-Za-z0-9가-힣])티[\s\-]*(원|투|쓰리|포|파이브)(?![가-힣])/gu, (m) => berthWords[m[1]!]!],
    [/(?<!\d)(\d{1,2})\s*번?\s*선석/gu, (m) => Number(m[1])],
  ];
  for (const [re, toNum] of berthPatterns) {
    for (const m of text.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (!overlaps(hits, start, end)) hits.push({ field: 'berth', value: `T${toNum(m)}`, start, end, method: 'pattern' });
    }
  }

  // 3) 시간: 오후 2시 30분 / 14:30 / 3시 반
  for (const m of text.matchAll(/(오전|오후)?\s*(\d{1,2})\s*시(?!간)(?:\s*(\d{1,2})\s*분|\s*(반))?/gu)) {
    const start = m.index! + (m[0].length - m[0].trimStart().length);
    const end = m.index! + m[0].length;
    if (overlaps(hits, start, end)) continue;
    let h = Number(m[2]);
    if (m[1] === '오후' && h < 12) h += 12;
    const min = m[4] ? 30 : m[3] ? Number(m[3]) : 0;
    hits.push({ field: 'time', value: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`, start, end, method: 'pattern' });
  }
  for (const m of text.matchAll(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/gu)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (!overlaps(hits, start, end)) hits.push({ field: 'time', value: `${m[1]!.padStart(2, '0')}:${m[2]}`, start, end, method: 'pattern' });
  }

  // 4) 거리
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(해리|마일|미터|킬로미터|킬로|km|m)(?![A-Za-z])/giu)) {
    const start = m.index!;
    const end = start + m[0].length;
    const unit = ({ 해리: 'NM', 마일: 'mile', 미터: 'm', 킬로미터: 'km', 킬로: 'km' } as Record<string, string>)[m[2]!] ?? m[2]!.toLowerCase();
    if (!overlaps(hits, start, end)) hits.push({ field: 'distance', value: `${m[1]}${unit}`, start, end, method: 'pattern' });
  }

  // 5) 식별번호: IMO 7자리, MMSI 9자리
  for (const m of text.matchAll(/IMO[\s\-]*(\d{7})(?!\d)|(?<!\d)(\d{9})(?!\d)/giu)) {
    const start = m.index!;
    const end = start + m[0].length;
    const value = m[1] ? `IMO${m[1]}` : `MMSI${m[2]}`;
    if (!overlaps(hits, start, end)) hits.push({ field: 'identifier', value, start, end, method: 'pattern' });
  }

  // 6) 선박: 알려진 이름(작업 기준) 우선, 그다음 "~호 / ~선박" 패턴
  const known = [...new Set(knownVessels.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const name of known) {
    const re = new RegExp(`(?<![A-Za-z0-9가-힣])${aliasPattern(name)}`, 'giu');
    for (const m of text.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (!overlaps(hits, start, end)) hits.push({ field: 'vessel', value: normalizeVesselName(name), start, end, method: 'vessel-name' });
    }
  }
  const vesselRe = new RegExp(
    `(?<![A-Za-z0-9가-힣])([A-Za-z]{1,3}|[A-Za-z0-9가-힣]{1,10}?)(\\s?)(선박|호|號)${PARTICLE_AFTER}`,
    'gu',
  );
  for (const m of text.matchAll(vesselRe)) {
    const name = m[1]!;
    const spaced = m[2] === ' ';
    if (spaced && !/^[A-Za-z]{1,3}$/.test(name) && !(name in LATIN_LETTER_NAMES)) continue;
    if (/^\d+$/.test(name) || VESSEL_STOP_NAMES.has(name)) continue;
    const start = m.index!;
    const end = start + m[0].length;
    if (!overlaps(hits, start, end)) hits.push({ field: 'vessel', value: normalizeVesselName(m[0]), start, end, method: 'pattern' });
  }

  // 7) 변경 의도 키워드
  for (const m of text.matchAll(CHANGE_KEYWORDS)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (!overlaps(hits, start, end)) hits.push({ field: 'changeIntent', value: 'true', start, end, method: 'keyword' });
  }

  hits.sort((a, b) => a.start - b.start);

  // 8) 정정·부정: "HPNT 말고 PNIT", "PNIT, 정정, HPNT"
  const correctionUnclear = new Set<EntityField>();
  const candidates: EntityCandidate[] = hits.map((h, i) => {
    let negated = false;
    if (h.field === 'terminal' || h.field === 'berth' || h.field === 'vessel') {
      const next = hits.slice(i + 1).find((o) => o.field === h.field);
      const after = text.slice(h.end);
      const between = next ? text.slice(h.end, next.start) : after;
      const directlyNegated = CORRECTION_AFTER.test(after);
      if (next && CORRECTION_BETWEEN.test(between)) negated = true;
      if (directlyNegated) {
        negated = true;
        if (!next) correctionUnclear.add(h.field);
      }
    }
    const surface = text.slice(h.start, h.end);
    return {
      field: h.field,
      value: h.value,
      surface,
      source,
      span: { start: h.start, end: h.end },
      segmentId: segmentIdFor(transcript, surface),
      method: h.method,
      negated,
    };
  });

  // 9) 유형 근거 없는 숫자 — 추정하지 않고 기록만
  const bareNumbers: string[] = [];
  for (const m of text.matchAll(/\d+(?:\.\d+)?/gu)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (!overlaps(hits, start, end)) bareNumbers.push(m[0]);
  }

  return { candidates, correctionUnclear: [...correctionUnclear], bareNumbers };
}
