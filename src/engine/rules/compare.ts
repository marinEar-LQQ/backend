import type {
  CatalogManifest,
  Comparison,
  ComparisonKind,
  CrossCheck,
  EntityCandidate,
  EntityField,
  FieldDiff,
  InstructionCode,
  ReasonCode,
  ResolvedEntities,
  TaskVersion,
  Transcript,
  Uncertainty,
} from '../../contracts';
import { extractCandidates, vesselCore, type ExtractionOutput } from './extract';

/**
 * ComparisonEngine — raw/enhanced 두 인식 결과를 합쳐 확정값·후보·불확실성을 만들고
 * 발화 시점 작업 버전과 비교한다 (백엔드 03장 표, 통합 03장 사례 A~D).
 *
 * 핵심 규칙
 *  - 두 인식 결과의 핵심 정보(선박·터미널·선석)가 다르면 확정하지 않는다 → ambiguous + ASR_DISAGREEMENT
 *    (한쪽에만 들린 경우도 "다름"으로 본다)
 *  - 터미널 없이 선석만 들리면 등록 터미널로 빈칸을 채우지 않는다 → ambiguous + TERMINAL_MISSING
 *  - 두 결과가 일치해도 정답 보장이 아니다 → match/difference 는 표시일 뿐, 자동 반영하지 않는다
 *  - crossCheck=pending 이면 enhanced 만으로 잠정 판정하고 CROSS_CHECK_PENDING 을 붙인다 (반영 차단)
 */

export interface AnalyzeInput {
  enhanced: Transcript | null;
  raw: Transcript | null;
  crossCheck: CrossCheck;
  /** 발화 시작 시점에 고정한 작업 버전. 없으면 비교 불가 */
  task: TaskVersion | null;
  catalog: CatalogManifest;
}

export interface AnalyzeOutput {
  candidates: EntityCandidate[];
  entities: ResolvedEntities;
  comparison: Comparison;
  uncertainties: Uncertainty[];
}

type FieldStatus = 'resolved' | 'missing' | 'uncertain';

interface FieldResolution {
  status: FieldStatus;
  value: string | null;
  alternatives: string[];
  reason: ReasonCode | null;
}

const uniq = (xs: string[]) => [...new Set(xs)];

function finalValues(ex: ExtractionOutput, field: EntityField): string[] {
  return uniq(ex.candidates.filter((c) => c.field === field && !c.negated).map((c) => c.value));
}

function allValues(ex: ExtractionOutput, field: EntityField): string[] {
  return uniq(ex.candidates.filter((c) => c.field === field).map((c) => c.value));
}

/** 위치 필드(터미널·선석)를 소스별 결과로 확정 */
function resolveLocationField(sources: ExtractionOutput[], field: 'terminal' | 'berth'): FieldResolution {
  const perSource = sources.map((s) => finalValues(s, field));
  const union = uniq(sources.flatMap((s) => allValues(s, field)));

  if (sources.some((s) => s.correctionUnclear.includes(field))) {
    return { status: 'uncertain', value: null, alternatives: union, reason: 'CORRECTION_UNCLEAR' };
  }
  if (perSource.some((vals) => vals.length > 1)) {
    return { status: 'uncertain', value: null, alternatives: uniq(perSource.flat()), reason: 'MULTIPLE_CANDIDATES' };
  }
  const singles = perSource.map((vals) => vals[0] ?? null);
  const present = singles.filter((v): v is string => v !== null);
  if (present.length === 0) return { status: 'missing', value: null, alternatives: [], reason: null };
  if (present.length !== singles.length || uniq(present).length > 1) {
    return { status: 'uncertain', value: null, alternatives: uniq(present), reason: 'ASR_DISAGREEMENT' };
  }
  // 어느 한쪽이라도 오인식 후보 사전("펜트"→HPNT)으로만 찾았으면 확정하지 않는다 — 후보로만 보여 주고 사용자가 확인
  const onlyConfusable = sources.some((s) => {
    const c = s.candidates.filter((x) => x.field === field && !x.negated);
    return c.length > 0 && c.every((x) => x.method === 'confusable');
  });
  if (onlyConfusable) return { status: 'uncertain', value: null, alternatives: uniq(present), reason: 'ASR_CONFUSABLE' };
  return { status: 'resolved', value: present[0]!, alternatives: [], reason: null };
}

interface VesselResolution {
  relation: 'task' | 'other' | 'missing' | 'uncertain';
  value: string | null;
  alternatives: string[];
  reason: ReasonCode | null;
}

function resolveVessel(sources: ExtractionOutput[], task: TaskVersion | null): VesselResolution {
  const taskCores = task ? [vesselCore(task.targetVessel), vesselCore(task.ownVessel)] : [];
  const targetCore = task ? vesselCore(task.targetVessel) : null;

  const perSource = sources.map((s) => {
    const names = finalValues(s, 'vessel');
    const related = names.filter((n) => taskCores.includes(vesselCore(n)));
    const target = names.filter((n) => vesselCore(n) === targetCore);
    const other = names.filter((n) => !taskCores.includes(vesselCore(n)));
    return { names, related, target, other };
  });
  const allNames = uniq(perSource.flatMap((p) => p.names));

  if (allNames.length === 0) return { relation: 'missing', value: null, alternatives: [], reason: 'VESSEL_MISSING' };

  // 소스 간 선박 언급이 다르면 대상 미확정 (한쪽에만 들린 경우 포함)
  const signatures = perSource.map((p) => p.names.map(vesselCore).sort().join('|'));
  if (uniq(signatures).length > 1) {
    return { relation: 'uncertain', value: null, alternatives: allNames, reason: 'ASR_DISAGREEMENT' };
  }

  const first = perSource[0]!;
  if (!task) {
    if (first.names.length === 1) return { relation: 'other', value: first.names[0]!, alternatives: [], reason: null };
    return { relation: 'uncertain', value: null, alternatives: allNames, reason: 'VESSEL_AMBIGUOUS' };
  }
  if (first.related.length > 0) {
    const value = first.target[0] ?? first.related[0]!;
    return { relation: 'task', value, alternatives: [], reason: null };
  }
  if (first.other.length > 0) {
    return { relation: 'other', value: first.other.length === 1 ? first.other[0]! : null, alternatives: first.other.length > 1 ? first.other : [], reason: 'OTHER_VESSEL' };
  }
  return { relation: 'missing', value: null, alternatives: [], reason: 'VESSEL_MISSING' };
}

function singleOrNull(sources: ExtractionOutput[], field: EntityField): string | null {
  const vals = uniq(sources.flatMap((s) => finalValues(s, field)));
  const perSource = sources.map((s) => finalValues(s, field).join('|'));
  if (vals.length === 1 && uniq(perSource).length === 1) return vals[0]!;
  return null;
}

export function analyzeUtterance(input: AnalyzeInput): AnalyzeOutput {
  const { enhanced, raw, crossCheck, task, catalog } = input;
  const knownVessels = task ? [task.targetVessel, task.ownVessel] : [];

  const exEnh = enhanced ? extractCandidates(enhanced, 'enhanced', catalog, knownVessels) : null;
  const exRaw = raw ? extractCandidates(raw, 'raw', catalog, knownVessels) : null;

  // 판정에 쓰는 소스: enhanced + (교차 검사 완료 시) raw. enhanced 가 없으면 raw 단독.
  const sources: ExtractionOutput[] = [];
  if (exEnh) sources.push(exEnh);
  if (exRaw && (crossCheck === 'complete' || !exEnh)) sources.push(exRaw);

  const candidates = [...(exEnh?.candidates ?? []), ...(exRaw?.candidates ?? [])];
  const reasons: ReasonCode[] = [];
  const uncertainties: Uncertainty[] = [];
  const diffs: FieldDiff[] = [];

  if (sources.length === 0) {
    return {
      candidates,
      entities: emptyEntities(),
      comparison: { kind: 'unknown', reasonCodes: ['VESSEL_MISSING', 'TERMINAL_MISSING'], taskId: task?.taskId ?? null, taskVersion: task?.version ?? null, diffs },
      uncertainties,
    };
  }

  const vessel = resolveVessel(sources, task);
  const terminal = resolveLocationField(sources, 'terminal');
  const berth = resolveLocationField(sources, 'berth');

  if (vessel.relation === 'uncertain') uncertainties.push({ field: 'vessel', alternatives: vessel.alternatives, reason: vessel.reason ?? 'VESSEL_AMBIGUOUS' });
  if (terminal.status === 'uncertain') uncertainties.push({ field: 'terminalId', alternatives: terminal.alternatives, reason: terminal.reason! });
  if (berth.status === 'uncertain') uncertainties.push({ field: 'berthId', alternatives: berth.alternatives, reason: berth.reason! });
  const bare = uniq(sources.flatMap((s) => s.bareNumbers));
  if (bare.length > 0) uncertainties.push({ field: 'number', alternatives: bare, reason: 'NUMBER_TYPE_UNCLEAR' });

  const entities: ResolvedEntities = {
    vessel: vessel.value,
    terminalId: terminal.value,
    berthId: berth.value,
    time: singleOrNull(sources, 'time'),
    distance: singleOrNull(sources, 'distance'),
    identifier: singleOrNull(sources, 'identifier'),
    changeIntent: sources.some((s) => s.candidates.some((c) => c.field === 'changeIntent')) ? true : null,
    speed: singleOrNull(sources, 'speed'),
    course: singleOrNull(sources, 'course'),
    // 지시어는 모든 소스(원음·완화음)에서 들린 것만 — 한쪽에서만 들린 지시는 확정처럼 번역하지 않는다
    instructions: (sources[0] ? finalValues(sources[0], 'instruction') : []).filter((code) =>
      sources.every((s) => finalValues(s, 'instruction').includes(code)),
    ) as InstructionCode[],
  };

  let kind: ComparisonKind;
  const addReason = (r: ReasonCode | null) => {
    if (r && !reasons.includes(r)) reasons.push(r);
  };

  if (!task) {
    kind = 'unknown';
    addReason('NO_TASK');
  } else if (vessel.relation === 'uncertain') {
    kind = 'ambiguous';
    addReason(vessel.reason);
  } else if (vessel.relation === 'other') {
    kind = 'unrelated';
    addReason('OTHER_VESSEL');
  } else if (vessel.relation === 'missing') {
    kind = 'unknown';
    addReason('VESSEL_MISSING');
    if (terminal.status === 'missing') addReason('TERMINAL_MISSING');
  } else if (terminal.status === 'uncertain' || berth.status === 'uncertain') {
    kind = 'ambiguous';
    addReason(terminal.reason);
    addReason(berth.reason);
  } else if (terminal.status === 'missing') {
    if (berth.status === 'resolved') {
      kind = 'ambiguous'; // 사례 C: "T3로"만 — 등록 터미널로 채우지 않음
      addReason('TERMINAL_MISSING');
    } else {
      kind = 'unknown';
      addReason('TERMINAL_MISSING');
      addReason('BERTH_MISSING');
    }
  } else {
    const t = catalog.terminals.find((x) => x.terminalId === terminal.value);
    if (berth.status === 'resolved' && t && !t.berths.some((b) => b.berthId === berth.value)) {
      kind = 'ambiguous';
      addReason('BERTH_NOT_IN_TERMINAL');
    } else {
      if (terminal.value !== task.terminalId) diffs.push({ field: 'terminalId', taskValue: task.terminalId, heardValue: terminal.value });
      if (berth.status === 'resolved' && berth.value !== task.berthId) diffs.push({ field: 'berthId', taskValue: task.berthId, heardValue: berth.value });
      if (diffs.length > 0) {
        kind = 'difference';
        addReason('LOCATION_DIFFERS');
      } else {
        kind = 'match';
        addReason('LOCATION_MATCHES');
      }
      if (berth.status === 'missing') addReason('BERTH_MISSING');
    }
  }

  if (crossCheck === 'pending') addReason('CROSS_CHECK_PENDING');

  return {
    candidates,
    entities,
    comparison: { kind, reasonCodes: reasons, taskId: task?.taskId ?? null, taskVersion: task?.version ?? null, diffs },
    uncertainties,
  };
}

export function emptyEntities(): ResolvedEntities {
  return { vessel: null, terminalId: null, berthId: null, time: null, distance: null, identifier: null, changeIntent: null, speed: null, course: null, instructions: [] };
}
