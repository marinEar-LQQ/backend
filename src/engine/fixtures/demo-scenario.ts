import type { TaskDraft } from '../../contracts';

/**
 * 시연 고정 데이터 (통합 03장 사례 A~D + 일치·정정).
 * 실제 모델 결과가 아니다 — origin='fixture' 로 표시되고 화면은 배지로 구분해야 한다.
 */

export interface DemoLine {
  id: string;
  label: string;
  /** 완화음 인식 결과 (시연용) */
  enhanced: string;
  /** 원음 인식 결과 (시연용) */
  raw: string;
  /** 합성 음성 길이 */
  durationMs: number;
}

export const DEMO_TASK: TaskDraft = {
  ownVessel: '해동호',
  targetVessel: 'A선박',
  terminalId: 'PNIT',
  berthId: 'T3',
  note: '시연 작업',
};

export const DEMO_SCENARIO: DemoLine[] = [
  {
    id: 'case-a',
    label: '사례 A · 장소 차이 (raw/enhanced 모두 HPNT)',
    enhanced: '해동호, A선박 작업 HPNT T3로 변경입니다.',
    raw: '해동호, A선박 작업 HPNT T3로 변경입니다.',
    durationMs: 2600,
  },
  {
    id: 'case-b',
    label: '사례 B · 인식 차이 (raw=PNIT, enhanced=HPNT)',
    enhanced: 'A선박 작업 HPNT T3로 변경입니다.',
    raw: 'A선박 작업 PNIT T3로 변경입니다.',
    durationMs: 2200,
  },
  {
    id: 'case-c',
    label: '사례 C · 터미널 미확정 (T3만)',
    enhanced: 'A선박 작업, T3로 갑니다.',
    raw: 'A선박 작업, T3로 갑니다.',
    durationMs: 1800,
  },
  {
    id: 'case-d',
    label: '사례 D · 다른 선박 (무관)',
    enhanced: 'B선박, HPNT T2로 이동하세요.',
    raw: 'B선박, HPNT T2로 이동하세요.',
    durationMs: 2000,
  },
  {
    id: 'case-match',
    label: '일치',
    enhanced: 'A선박 PNIT T3 접안 예정, 오후 2시 30분입니다.',
    raw: 'A선박 PNIT T3 접안 예정, 오후 2시 30분입니다.',
    durationMs: 2600,
  },
  {
    id: 'case-correction',
    label: '정정 ("HPNT 말고 PNIT")',
    enhanced: 'A선박 HPNT 말고 PNIT T3로 정정합니다.',
    raw: 'A선박 HPNT 말고 PNIT T3로 정정합니다.',
    durationMs: 2400,
  },
];
