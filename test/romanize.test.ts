import { describe, expect, it } from 'vitest';
import { romanize, withRoman } from '../src/engine/translate/romanize';

describe('한글 이름 로마자 표기 (외국어 번역 화면)', () => {
  it('선박명·장소를 글자대로 옮긴다', () => {
    expect(romanize('동방호')).toBe('Dongbangho');
    expect(romanize('신선대부두')).toBe('Sinseondaebudu');
    expect(romanize('팔미도')).toBe('Palmido');
    expect(romanize('제3해진호')).toBe('Je3haejinho');
    expect(romanize('한라호')).toBe('Hallaho');
  });
  it('한글 이름 옆에 덧붙이고, 영문·숫자 값은 건드리지 않는다', () => {
    expect(withRoman('[동방호 / 공방호] (check)')).toBe('[동방호 (Dongbangho) / 공방호 (Gongbangho)] (check)');
    expect(withRoman('부산 남쪽 바다')).toBe('부산 남쪽 바다 (Busan Namjjok Bada)');
    expect(withRoman('PNIT, 2 mi, 14:30')).toBe('PNIT, 2 mi, 14:30');
  });
});
