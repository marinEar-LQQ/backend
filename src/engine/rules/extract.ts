import type { CatalogManifest, EntityCandidate, EntityField, InstructionCode, Transcript, TranscriptSource } from '../../contracts';

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
  // 교신 상투어 (호출부호, 수신 양호)
  '호출부', '양', '수신양', '감도양',
]);

const PARTICLE_AFTER = '(?=$|[\\s,.!?·~]|은|는|이|가|을|를|에|의|로|으로|도|와|과|께|랑|야|님|측)';
const CORRECTION_AFTER = /^\s*(?:이|가|은|는)?\s*(?:말고|아니고|아니라|아니야|아닙니다|아님|대신|취소)/;
const CORRECTION_BETWEEN = /정정|말고|아니고|아니라|대신|취소/;
const CHANGE_KEYWORDS = /변경|바꿔|바꾸|바뀌|바뀝|이동|옮겨|옮기|대신|말고|정정|아니고|아니라/g;

const SINO = '공일이삼사오육칠팔구';

/** 무전식 한 자리씩 읽은 수: "삼이공" → "320", "일일" → "11", "영" = 0 */
export function sinoDigits(s: string): string | null {
  let out = '';
  for (const ch of s) {
    const d = ch === '영' ? 0 : SINO.indexOf(ch);
    if (d < 0) return null;
    out += String(d);
  }
  return out ? String(Number(out)) : null;
}

const EN_NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
function englishNumber(s: string): string | null {
  if (/^\d+$/.test(s)) return s;
  const i = EN_NUM.indexOf(s.toLowerCase());
  return i >= 0 ? String(i) : null;
}
function englishDigits(s: string): string | null {
  const parts = s.split(/[\s\-]+/).map((p) => (/^\d$/.test(p) ? p : String(EN_NUM.indexOf(p.toLowerCase()))));
  return parts.some((p) => p === '-1') ? null : parts.join('');
}

const INSTRUCTION_PATTERNS: Array<[InstructionCode, RegExp]> = [
  ['REDUCE_SPEED', /감속|속력을?\s*줄|reduce\s+speed|slow\s+down/giu],
  ['PASS_PORT_TO_PORT', /좌현\s*대\s*좌현|port\s+to\s+port/giu],
  ['PASS_STBD_TO_STBD', /우현\s*대\s*우현|starboard\s+to\s+starboard/giu],
  ['KEEP_CLEAR', /우회|피해\s*가|피하|keep(?:ing)?\s+clear/giu],
  ['STAND_BY', /대기(?:해라|하십시오|하세요|바랍니다|중)|stand\s*by/giu],
  ['BERTH', /접안|berthing|\bberth\b(?!\s*(?:one|two|three|four|five|\d))/giu],
  ['PROCEED', /이동하(?:십시오|세요|라)|진입\s*허가|proceed(?:ing)?/giu],
  ['ALTER_COURSE_STBD', /우현으로\s*(?:크게\s*)?(?:돌|변침|피)/gu],
  ['ALTER_COURSE_PORT', /좌현으로\s*(?:크게\s*)?(?:돌|변침|피)/gu],
  ['CORRECTION', /정정합니다|정정,|correction/giu],
];

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
    // 뒤에 영문이 붙으면 다른 낱말로 보되, "HPNTT 3"처럼 선석 T+숫자가 붙은 경우는 허용 (띄어쓰기 처리일 뿐 발음 보정 아님)
    const re = new RegExp(`(?<![A-Za-z])${aliasPattern(alias)}(?=$|[^A-Za-z]|[Tt][\\s\\-]*\\d)`, 'giu');
    for (const m of text.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (!overlaps(hits, start, end)) hits.push({ field: 'terminal', value: terminalId, start, end, method: 'catalog-alias' });
    }
  }

  // 1-b) 오인식 후보 사전: 실측에서 자주 틀린 표기("펜트"→HPNT). 후보로만 남기고 compare 에서 확정하지 않는다
  const confusableList = catalog.terminals
    .flatMap((t) => (t.confusables ?? []).map((a) => ({ alias: a, terminalId: t.terminalId })))
    .sort((a, b) => b.alias.length - a.alias.length);
  for (const { alias, terminalId } of confusableList) {
    const re = new RegExp(`(?<![A-Za-z가-힣])${aliasPattern(alias)}(?=$|[^A-Za-z]|[Tt][\\s\\-]*\\d)`, 'giu');
    for (const m of text.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (!overlaps(hits, start, end)) hits.push({ field: 'terminal', value: terminalId, start, end, method: 'confusable' });
    }
  }

  // 2) 선석: T3 / 티3 / 티쓰리 / 3번 선석 — 유형 근거가 있는 표현만
  const berthWords: Record<string, number> = { 원: 1, 투: 2, 쓰리: 3, 포: 4, 파이브: 5 };
  const berthPatterns: Array<[RegExp, (m: RegExpMatchArray) => number]> = [
    [/(?<![A-Za-z0-9가-힣])(?:T|티)[\s\-]*(\d{1,2})(?!\d)/giu, (m) => Number(m[1])],
    [/(?<![A-Za-z0-9가-힣])티[\s\-]*(원|투|쓰리|포|파이브)(?![가-힣])/gu, (m) => berthWords[m[1]!]!],
    [/(?<!\d)(\d{1,2})\s*번?\s*선석/gu, (m) => Number(m[1])],
    // 무전에서는 한자어 수사로 읽는다: "이번 선석"=2번, "삼번 선석"=3번 ("이번"은 '선석'이 바로 뒤에 올 때만)
    [/(?<![가-힣])(일|이|삼|사|오|육|칠|팔|구)\s*번\s*선석/gu, (m) => '일이삼사오육칠팔구'.indexOf(m[1]!) + 1],
    [/\bberth\s*(one|two|three|four|five|\d)\b/giu, (m) => (['one', 'two', 'three', 'four', 'five'].indexOf(m[1]!.toLowerCase()) + 1) || Number(m[1])],
  ];
  // 터미널 약어 바로 뒤에 붙은 T+숫자 ("HP NTT 3" → HPNT + T3)
  for (const h of hits.filter((x) => x.field === 'terminal')) {
    const m = text.slice(h.end).match(/^[Tt][\s\-]*(\d{1,2})(?!\d)/);
    if (m) hits.push({ field: 'berth', value: `T${Number(m[1])}`, start: h.end, end: h.end + m[0].length, method: 'pattern' });
  }
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

  // 4-b) 속력: "8노트", "속력 팔 노트", "속력 일일 노트"(=11, 무전식 한 자리씩 읽기), "ten knots"
  for (const m of text.matchAll(/(?:속력\s*([공영일이삼사오육칠팔구]{1,3})|(\d+(?:\.\d+)?))\s*노트|\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*knots?\b/giu)) {
    const start = m.index!;
    const end = start + m[0].length;
    const v = m[1] ? sinoDigits(m[1]) : m[2] ? m[2] : englishNumber(m[3]!);
    if (v !== null && !overlaps(hits, start, end)) hits.push({ field: 'speed', value: `${v}kn`, start, end, method: 'pattern' });
  }

  // 4-c) 침로: "침로 삼이공도"(=320°), "침로 215도", "course zero-one-five"
  for (const m of text.matchAll(/침로\s*([공영일이삼사오육칠팔구]{1,3}|\d{1,3})\s*도|침로\s*(\d{3})(?!\d)|\bcourse\s*((?:zero|one|two|three|four|five|six|seven|eight|nine|\d)(?:[\s\-]+(?:zero|one|two|three|four|five|six|seven|eight|nine|\d)){0,2})\b/giu)) {
    const start = m.index!;
    const end = start + m[0].length;
    const v = m[1] ? (/^\d+$/.test(m[1]) ? m[1] : sinoDigits(m[1])) : m[2] ? m[2] : englishDigits(m[3]!);
    if (v !== null && !overlaps(hits, start, end)) hits.push({ field: 'course', value: `${v.padStart(3, '0')}°`, start, end, method: 'pattern' });
  }

  // 4-d) 관제 지시어 (IMO 해사 표준 문구로 번역할 코드). 위치가 겹쳐도 허용 — 지시어는 다른 값과 별개로 센다
  for (const [code, re] of INSTRUCTION_PATTERNS) {
    for (const m of text.matchAll(re)) {
      hits.push({ field: 'instruction', value: code, start: m.index!, end: m.index! + m[0].length, method: 'keyword' });
    }
  }

  // 5-a) 호출부호: "호출부호 6KLM", "call sign D7AB" (영문·숫자 3~7자)
  for (const m of text.matchAll(/(?:호출부호|call\s*sign)\s*[:,]?\s*([A-Z0-9]{3,7})(?![A-Za-z0-9])/giu)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (!overlaps(hits, start, end)) hits.push({ field: 'identifier', value: `CALLSIGN ${m[1]!.toUpperCase()}`, start, end, method: 'pattern' });
  }

  // 5) 식별번호: IMO 7자리, MMSI 9자리
  for (const m of text.matchAll(/IMO[\s\-]*(\d{7})(?!\d)|(?<!\d)(\d{9})(?!\d)/giu)) {
    const start = m.index!;
    const end = start + m[0].length;
    const value = m[1] ? `IMO${m[1]}` : `MMSI${m[2]}`;
    if (!overlaps(hits, start, end)) hits.push({ field: 'identifier', value, start, end, method: 'pattern' });
  }

  // 6-a) 영어 교신의 자기 호출: "this is Hanjin Ocean"
  for (const m of text.matchAll(/\bthis is ([A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2})/gu)) {
    const start = m.index! + m[0].length - m[1]!.length;
    const end = m.index! + m[0].length;
    if (!/^(Busan|VTS|Port)\b/.test(m[1]!) && !overlaps(hits, start, end)) hits.push({ field: 'vessel', value: m[1]!.toUpperCase(), start, end, method: 'pattern' });
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
