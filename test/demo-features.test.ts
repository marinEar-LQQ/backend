import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '../src/contracts';
import { DEMO_CATALOG } from '../src/engine/catalog/demo-catalog';
import { analyzeUtterance } from '../src/engine/rules/compare';
import { extractCandidates, sinoDigits } from '../src/engine/rules/extract';
import { buildSummary } from '../src/engine/translate/summary';
import { splitClauses } from '../src/engine/translate/protect';
import { TASK_V1, tr } from './helpers';

const run = (enh: string, raw = enh) => {
  const o = analyzeUtterance({ enhanced: tr(enh), raw: tr(raw), crossCheck: 'complete', task: TASK_V1, catalog: DEMO_CATALOG });
  return { ...o, enhancedTranscript: tr(enh), rawTranscript: tr(raw) } as unknown as AnalysisResult;
};
const vals = (t: string, f: string) => extractCandidates(tr(t), 'enhanced', DEMO_CATALOG).candidates.filter((c) => c.field === f).map((c) => c.value);

describe('오인식 후보 사전 (실측 표기)', () => {
  it('"펜트 2번 선석" → HPNT 후보, 확정하지 않음', () => {
    const r = run('A선박 차항지 펜트 2번 선석 접안 예정');
    expect(r.entities.terminalId).toBeNull();
    expect(r.comparison.kind).toBe('ambiguous');
    expect(r.comparison.reasonCodes).toContain('ASR_CONFUSABLE');
    expect(r.uncertainties.find((u) => u.field === 'terminalId')?.alternatives).toEqual(['HPNT']);
  });
  it('정상 별칭은 그대로 확정', () => {
    expect(run('A선박 HPNT 2번 선석 접안').entities.terminalId).toBe('HPNT');
  });
});

describe('속력·침로·지시어', () => {
  it('무전식 수사', () => {
    expect(sinoDigits('삼이공')).toBe('320');
    expect(sinoDigits('일일')).toBe('11');
    expect(sinoDigits('영삼')).toBe('3');
  });
  it('대본 1 문장', () => {
    const t = '침로 삼이공도, 속력 일일 노트입니다. 속력 팔 노트로 감속하시고 좌현 대 좌현으로 통과하십시오.';
    expect(vals(t, 'course')).toEqual(['320°']);
    expect(vals(t, 'speed')).toEqual(['11kn', '8kn']);
    expect(vals(t, 'instruction')).toEqual(expect.arrayContaining(['REDUCE_SPEED', 'PASS_PORT_TO_PORT']));
  });
  it('영어 교신', () => {
    const t = 'course zero-one-five, speed ten knots. keeping clear to starboard, proceeding to pilot station';
    expect(vals(t, 'course')).toEqual(['015°']);
    expect(vals(t, 'speed')).toEqual(['10kn']);
    expect(vals(t, 'instruction')).toEqual(expect.arrayContaining(['KEEP_CLEAR', 'PROCEED']));
  });
  it('Whisper 숫자 표기 "침로 306"', () => {
    expect(vals('침로 306 속력', 'course')).toEqual(['306°']);
  });
});

describe('정형 요약 카드', () => {
  it('en/id/vi 요약에 값은 그대로, 지시어는 표준 문구', () => {
    const r = run('A선박 PNIT 3번 선석, 속력 팔 노트로 감속하시고 좌현 대 좌현으로 통과하십시오.');
    const en = buildSummary(r, 'en')!;
    expect(en.oneLine).toBe('Vessel: A선박 | Terminal: PNIT | Berth: 3 | Speed: 8 knots | Instruction: Reduce speed · Pass port to port');
    expect(buildSummary(r, 'vi')!.oneLine).toContain('Giảm tốc độ');
    expect(buildSummary(r, 'id')!.oneLine).toContain('Kurangi kecepatan');
    expect(buildSummary(r, 'my')).toBeNull();
  });
  it('불확실한 터미널은 확인 필요 표시', () => {
    const r = run('A선박 HPNT T3로 변경', 'A선박 PNIT T3로 변경');
    expect(buildSummary(r, 'en')!.lines.find((l) => l.field === 'terminal')).toMatchObject({ value: '[HPNT / PNIT] (check)', uncertain: true });
  });
});

describe('참고 번역 절 나누기', () => {
  it('연결어미·마침표 단위', () => {
    expect(splitClauses('현대부산호, 여기는 부산항 VTS. 현재 PNIT 1번 선석에서 출항 중인 외항선 있으니 속력 8노트로 감속하시고 좌현 대 좌현으로 통과하십시오.')).toEqual([
      '현대부산호',
      '여기는 부산항 VTS.',
      '현재 PNIT 1번 선석에서 출항 중인 외항선 있으니',
      '속력 8노트로 감속하시고',
      '좌현 대 좌현으로 통과하십시오.',
    ]);
  });
});

import { diffTranscripts } from '../src/engine/rules/diff';

describe('시연 녹음(mono_noisy) 지원', () => {
  it('고유어 시각 "세 시"', () => {
    expect(vals('세 시에 교대하고 라면이나 먹어야겠다.', 'time')).toEqual(['03:00']);
    expect(vals('오후 다섯 시 반 입항', 'time')).toEqual(['17:30']);
    expect(vals('열 시간 대기', 'time')).toEqual([]);
  });
  it('원음/완화음 단어 차이', () => {
    const d = diffTranscripts('오늘 사람이 많이 보네 대시에 두대하고 라면이나 먹어야겠다', '오늘 바람이 많이 부네. 세 시에 교대하고 라면이나 먹어야겠다.');
    const changed = d.filter((x) => x.op !== 'same');
    expect(changed.map((x) => [x.raw, x.enhanced])).toEqual([
      ['사람이', '바람이'],
      ['보네', '부네.'],
      ['대시에', '세'],
      ['두대하고', '시에'],
      [null, '교대하고'],
    ]);
    expect(d.filter((x) => x.op === 'same').map((x) => x.enhanced)).toEqual(['오늘', '많이', '라면이나', '먹어야겠다.']);
  });
});
