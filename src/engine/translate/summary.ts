import { withRoman } from './romanize';
import type { AnalysisResult, CatalogManifest, InstructionCode, LangCode, SummaryLine, TranslationSummary } from '../../contracts';

/**
 * 정형 요약 카드: 번역 모델 없이 추출값을 미리 번역해 둔 틀에 채운다.
 * 선박명·터미널·선석·속력·침로는 값을 그대로 쓰고, 지시어만 IMO 해사 표준 문구(SMCP) 기반 표현으로 바꾼다.
 * 불확실한 값은 [A / B] 와 "확인 필요" 표시를 유지한다 — 기계번역이 값을 지어내는 문제를 피한다.
 * id / vi 문구는 원어민 검수 전이다.
 */

type SummaryLang = 'ko' | 'en' | 'id' | 'vi';
export const SUMMARY_LANGS: readonly LangCode[] = ['ko', 'en', 'id', 'vi'];

const LABELS: Record<SummaryLang, Record<SummaryLine['field'], string> & { check: string }> = {
  ko: { vessel: '선박', terminal: '터미널', berth: '선석', place: '위치', distance: '거리', identifier: '식별', time: '시각', speed: '속력', course: '침로', instruction: '지시', check: '확인 필요' },
  en: { vessel: 'Vessel', terminal: 'Terminal', berth: 'Berth', place: 'Location', distance: 'Distance', identifier: 'ID', time: 'Time', speed: 'Speed', course: 'Course', instruction: 'Instruction', check: 'check' },
  id: { vessel: 'Kapal', terminal: 'Terminal', berth: 'Dermaga', place: 'Lokasi', distance: 'Jarak', identifier: 'ID', time: 'Waktu', speed: 'Kecepatan', course: 'Haluan', instruction: 'Instruksi', check: 'periksa' },
  vi: { vessel: 'Tàu', terminal: 'Bến cảng', berth: 'Cầu cảng', place: 'Vị trí', distance: 'Khoảng cách', identifier: 'ID', time: 'Thời gian', speed: 'Tốc độ', course: 'Hướng đi', instruction: 'Chỉ thị', check: 'cần kiểm tra' },
};

export const PHRASEBOOK: Record<InstructionCode, Record<SummaryLang, string>> = {
  REDUCE_SPEED: { ko: '감속', en: 'Reduce speed', id: 'Kurangi kecepatan', vi: 'Giảm tốc độ' },
  PASS_PORT_TO_PORT: { ko: '좌현 대 좌현 통과', en: 'Pass port to port', id: 'Berpapasan lambung kiri dengan lambung kiri', vi: 'Tránh nhau mạn trái với mạn trái' },
  PASS_STBD_TO_STBD: { ko: '우현 대 우현 통과', en: 'Pass starboard to starboard', id: 'Berpapasan lambung kanan dengan lambung kanan', vi: 'Tránh nhau mạn phải với mạn phải' },
  KEEP_CLEAR: { ko: '피해서 우회', en: 'Keep clear', id: 'Jaga jarak, memutar', vi: 'Tránh xa, đi vòng' },
  STAND_BY: { ko: '대기', en: 'Stand by', id: 'Siaga, tunggu', vi: 'Chờ lệnh' },
  BERTH: { ko: '접안', en: 'Berthing', id: 'Sandar', vi: 'Cập cầu' },
  PROCEED: { ko: '이동', en: 'Proceed', id: 'Lanjutkan', vi: 'Di chuyển' },
  ALTER_COURSE_STBD: { ko: '우현으로 변침', en: 'Alter course to starboard', id: 'Ubah haluan ke kanan', vi: 'Chuyển hướng sang phải' },
  ALTER_COURSE_PORT: { ko: '좌현으로 변침', en: 'Alter course to port', id: 'Ubah haluan ke kiri', vi: 'Chuyển hướng sang trái' },
  CORRECTION: { ko: '정정', en: 'Correction', id: 'Koreksi', vi: 'Đính chính' },
  ENGINE_TROUBLE: { ko: '엔진 이상', en: 'Engine trouble', id: 'Gangguan mesin', vi: 'Sự cố động cơ' },
  TOW_REQUESTED: { ko: '예인 요청', en: 'Tow requested', id: 'Meminta kapal tunda', vi: 'Yêu cầu tàu kéo' },
};

function speedText(v: string, lang: SummaryLang): string {
  const n = v.replace(/kn$/, '');
  return { ko: `${n}노트`, en: `${n} knots`, id: `${n} knot`, vi: `${n} hải lý/giờ` }[lang];
}

export function buildSummary(result: AnalysisResult, lang: LangCode, catalog?: CatalogManifest): TranslationSummary | null {
  const termName = (id: string) => catalog?.terminals.find((t) => t.terminalId === id)?.displayName ?? id;
  if (!(SUMMARY_LANGS as readonly string[]).includes(lang)) return null;
  const L = LABELS[lang as SummaryLang];
  const lines: SummaryLine[] = [];
  const unc = (field: string) => result.uncertainties.find((u) => u.field === field && u.reason !== 'MULTIPLE_CANDIDATES');
  const push = (field: SummaryLine['field'], value: string | null, uncertainField?: string) => {
    const u = uncertainField ? unc(uncertainField) : undefined;
    if (u && u.alternatives.length) {
      lines.push({ field, label: L[field], value: `[${u.alternatives.join(' / ')}] (${L.check})`, uncertain: true });
    } else if (value) {
      lines.push({ field, label: L[field], value, uncertain: false });
    }
  };

  // 선박: 확정값이 있으면 그것, 아니면 들린 이름들 (다른 배 교신도 이름은 보여 준다)
  const vessels = [...new Set(result.candidates.filter((c) => c.field === 'vessel' && !c.negated).map((c) => c.value))];
  push('vessel', result.entities.vessel ?? (vessels.length ? vessels.join(', ') : null), 'vessel');

  // 터미널·선석: 한 문장에 여러 장소가 나오면 모두 보여 준다
  const terminals = [...new Set(result.candidates.filter((c) => c.field === 'terminal' && !c.negated).map((c) => c.value))];
  push('terminal', result.entities.terminalId ? termName(result.entities.terminalId) : terminals.length ? terminals.map(termName).join(', ') : null, 'terminalId');
  push('berth', result.entities.berthId ? result.entities.berthId.replace(/^T/, '') : null, 'berthId');
  push('time', result.entities.time, 'time');

  // 여러 값이 나올 수 있는 항목 (속력 12→8노트, 거리 2마일·500미터 …):
  // 원음·완화음 둘 다에서 들린 값만 확정으로, 한쪽에서만 들린 값은 "확인 필요"로 (12노트 vs 10노트 같은 숫자 오인식 대비)
  const multi = (field: SummaryLine['field'], fmt: (v: string) => string = (v) => v, sep = ', ') => {
    const vals = (src: 'raw' | 'enhanced') => [...new Set(result.candidates.filter((c) => c.field === field && c.source === src && !c.negated).map((c) => c.value))];
    const enh = vals('enhanced');
    const cross = result.crossCheck === 'complete' && result.rawTranscript;
    const raw = cross ? vals('raw') : enh;
    const agreed = enh.filter((v) => raw.includes(v));
    const disputed = [...enh.filter((v) => !raw.includes(v)), ...raw.filter((v) => !enh.includes(v))];
    if (agreed.length) lines.push({ field, label: L[field], value: agreed.map(fmt).join(sep), uncertain: false });
    if (disputed.length) lines.push({ field, label: L[field], value: `[${disputed.map(fmt).join(' / ')}] (${L.check})`, uncertain: true });
  };
  multi('place');
  multi('speed', (v) => speedText(v, lang as SummaryLang), ' → '); // 속력은 말한 순서대로 변화 (12 → 8노트)
  if (result.entities.course) push('course', result.entities.course);
  multi('distance', (v) => v.replace(/mile$/, lang === 'ko' ? '마일' : ' mi').replace(/NM$/, lang === 'ko' ? '해리' : ' NM'));
  multi('identifier', (v) => v.replace(/^CALLSIGN /, lang === 'ko' ? '호출부호 ' : 'Call sign ').replace(/^CH /, lang === 'ko' ? '채널 ' : 'Ch '));
  if (result.entities.instructions.length) {
    push('instruction', result.entities.instructions.map((c) => PHRASEBOOK[c][lang as SummaryLang]).join(' · '));
  }

  // 외국어 화면: 한글 이름 옆에 읽는 법을 덧붙인다 (값 자체는 그대로)
  if (lang !== 'ko') for (const l of lines) l.value = withRoman(l.value);

  return { lang, lines, oneLine: lines.map((l) => `${l.label}: ${l.value}`).join(' | ') };
}
