import { describe, expect, it } from 'vitest';
import { restoreTokens } from '../src/engine/translate/protect';
import { cleanTranscript } from '../src/engine/models/transformers-providers';

const tokens = [
  { placeholder: '[1]', value: 'A선박', field: 'vessel' as const },
  { placeholder: '[2]', value: '[HPNT / PNIT]', field: 'uncertain' as const },
];

describe('번역 보호 토큰 복원·검증', () => {
  it('정상 복원', () => {
    const r = restoreTokens('Pekerjaan [1] diubah ke [2].', tokens);
    expect(r.ok).toBe(true);
    expect(r.text).toBe('Pekerjaan A선박 diubah ke [HPNT / PNIT].');
  });

  it('모델이 placeholder 를 빠뜨리면 needs_check 사유를 남기고 값을 만들어내지 않음', () => {
    const r = restoreTokens('Pekerjaan [1] diubah.', tokens);
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toContain('[HPNT / PNIT]');
    expect(r.text).not.toContain('HPNT');
  });

  it('중복·알 수 없는 placeholder 감지', () => {
    expect(restoreTokens('[1] [1] [2]', tokens).issues.some((i) => i.includes('중복'))).toBe(true);
    expect(restoreTokens('[1] [2] [3]', tokens).issues.some((i) => i.includes('알 수 없는'))).toBe(true);
  });
});

describe('Whisper 환각 문장 제거', () => {
  it('무음에서 자주 나오는 문장 제거', () => {
    expect(cleanTranscript('시청해주셔서 감사합니다.')).toBe('');
    expect(cleanTranscript('A선박 PNIT T3 접안')).toBe('A선박 PNIT T3 접안');
  });
});
