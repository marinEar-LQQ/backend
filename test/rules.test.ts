import { describe, expect, it } from 'vitest';
import { DEMO_CATALOG } from '../src/engine/catalog/demo-catalog';
import { analyzeUtterance } from '../src/engine/rules/compare';
import { extractCandidates, normalizeVesselName } from '../src/engine/rules/extract';
import { TASK_V1, tr } from './helpers';

const run = (enh: string | null, raw: string | null, opts: { pending?: boolean; noTask?: boolean } = {}) =>
  analyzeUtterance({
    enhanced: enh === null ? null : tr(enh),
    raw: raw === null ? null : tr(raw),
    crossCheck: opts.pending ? 'pending' : 'complete',
    task: opts.noTask ? null : TASK_V1,
    catalog: DEMO_CATALOG,
  });

describe('추출 (EntityResolver)', () => {
  it('터미널 별칭·띄어쓴 약어·한국어 호칭을 같은 ID로 연결', () => {
    for (const text of ['PNIT T3', 'P N I T 티3', '피엔아이티 3번 선석', 'pnit t-3', 'PN ITT 3']) {
      const ex = extractCandidates(tr(text), 'enhanced', DEMO_CATALOG);
      expect(ex.candidates.find((c) => c.field === 'terminal')?.value, text).toBe('PNIT');
      expect(ex.candidates.find((c) => c.field === 'berth')?.value, text).toBe('T3');
    }
  });

  it('근거 없는 숫자는 선석·시간으로 추정하지 않음', () => {
    const ex = extractCandidates(tr('A선박 3으로 가세요'), 'enhanced', DEMO_CATALOG);
    expect(ex.candidates.some((c) => c.field === 'berth' || c.field === 'time')).toBe(false);
    expect(ex.bareNumbers).toEqual(['3']);
  });

  it('시간·거리 추출, "3시간"은 시각이 아님', () => {
    const ex = extractCandidates(tr('오후 2시 30분 입항, 1.5해리 전방, 3시간 대기'), 'enhanced', DEMO_CATALOG);
    expect(ex.candidates.filter((c) => c.field === 'time').map((c) => c.value)).toEqual(['14:30']);
    expect(ex.candidates.find((c) => c.field === 'distance')?.value).toBe('1.5NM');
  });

  it('선박명 정규화', () => {
    expect(normalizeVesselName('에이 선박')).toBe('A선박');
    expect(normalizeVesselName('해동號')).toBe('해동호');
    const ex = extractCandidates(tr('번호 확인, 신호 대기. 해동호는 대기'), 'enhanced', DEMO_CATALOG);
    expect(ex.candidates.filter((c) => c.field === 'vessel').map((c) => c.value)).toEqual(['해동호']);
  });
});

describe('비교 규칙 (통합 03장 사례 A~D, 백엔드 03장 표)', () => {
  it('사례 A: raw/enhanced 모두 HPNT T3 → difference, 기준 자동 변경 없음', () => {
    const r = run('A선박 작업, HPNT T3로 변경.', 'A선박 작업, HPNT T3로 변경.');
    expect(r.comparison.kind).toBe('difference');
    expect(r.entities.terminalId).toBe('HPNT');
    expect(r.comparison.diffs).toEqual([{ field: 'terminalId', taskValue: 'PNIT', heardValue: 'HPNT' }]);
    expect(r.entities.changeIntent).toBe(true);
  });

  it('사례 B: raw=PNIT, enhanced=HPNT → ambiguous, terminalId=null, 후보 2개', () => {
    const r = run('A선박 작업, HPNT T3로 변경.', 'A선박 작업, PNIT T3로 변경.');
    expect(r.comparison.kind).toBe('ambiguous');
    expect(r.comparison.reasonCodes).toContain('ASR_DISAGREEMENT');
    expect(r.entities.terminalId).toBeNull();
    expect(r.entities.berthId).toBe('T3');
    expect(r.uncertainties.find((u) => u.field === 'terminalId')?.alternatives.sort()).toEqual(['HPNT', 'PNIT']);
  });

  it('사례 C: "T3로"만 → 등록 터미널로 채우지 않고 ambiguous', () => {
    const r = run('A선박 작업, T3로.', 'A선박 작업, T3로.');
    expect(r.comparison.kind).toBe('ambiguous');
    expect(r.comparison.reasonCodes).toContain('TERMINAL_MISSING');
    expect(r.entities.terminalId).toBeNull();
  });

  it('사례 D: 다른 선박 → unrelated', () => {
    const r = run('B선박 HPNT T2로 이동.', 'B선박 HPNT T2로 이동.');
    expect(r.comparison.kind).toBe('unrelated');
  });

  it('기준과 같음 → match (자동 승인 아님)', () => {
    const r = run('A선박 PNIT T3 접안 예정', 'A선박 PNIT T3 접안 예정');
    expect(r.comparison.kind).toBe('match');
  });

  it('정정: "HPNT 말고 PNIT" → PNIT 로 확정', () => {
    const r = run('A선박 HPNT 말고 PNIT T3', 'A선박 HPNT 말고 PNIT T3');
    expect(r.entities.terminalId).toBe('PNIT');
    expect(r.comparison.kind).toBe('match');
  });

  it('정정 대상 없이 부정만 → ambiguous 유지', () => {
    const r = run('A선박 HPNT 아니고요', 'A선박 HPNT 아니고요');
    expect(r.comparison.kind).toBe('ambiguous');
    expect(r.comparison.reasonCodes).toContain('CORRECTION_UNCLEAR');
  });

  it('선박명 판별 불가 → unknown', () => {
    const r = run('HPNT T3로 변경', 'HPNT T3로 변경');
    expect(r.comparison.kind).toBe('unknown');
    expect(r.comparison.reasonCodes).toContain('VESSEL_MISSING');
  });

  it('raw 에서 선박명이 엇갈림 → ambiguous', () => {
    const r = run('A선박 HPNT T3', 'B선박 HPNT T3');
    expect(r.comparison.kind).toBe('ambiguous');
  });

  it('crossCheck pending → enhanced 로 잠정 판정 + CROSS_CHECK_PENDING', () => {
    const r = run('A선박 HPNT T3로 변경', null, { pending: true });
    expect(r.comparison.kind).toBe('difference');
    expect(r.comparison.reasonCodes).toContain('CROSS_CHECK_PENDING');
  });

  it('등록 작업 없음 → unknown + NO_TASK', () => {
    const r = run('A선박 HPNT T3', 'A선박 HPNT T3', { noTask: true });
    expect(r.comparison.kind).toBe('unknown');
    expect(r.comparison.reasonCodes).toEqual(['NO_TASK']);
  });

  it('한 문장에 터미널 두 개 (정정 없음) → MULTIPLE_CANDIDATES', () => {
    const r = run('A선박 PNIT HPNT T3', 'A선박 PNIT HPNT T3');
    expect(r.comparison.kind).toBe('ambiguous');
    expect(r.comparison.reasonCodes).toContain('MULTIPLE_CANDIDATES');
  });
});
