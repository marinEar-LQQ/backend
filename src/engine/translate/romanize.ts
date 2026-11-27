/**
 * 한글 이름의 로마자 표기 (국어의 로마자 표기법 기준, 글자 단위).
 * 번역 화면에서 선박명·장소가 한글로만 나오면 한국어를 못 읽는 선원이 읽을 수 없다 (배포본 검수 2026-11-28).
 * 값은 바꾸지 않고 한글 옆에 읽는 법만 덧붙인다: "제3해진호 (Je3haejinho)".
 * 소리 변화는 ㄴ+ㄹ, ㄹ+ㄹ → "ll" 만 처리한다 (한라 → Halla). 나머지는 글자대로.
 */

const INITIAL = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const MEDIAL = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const FINAL = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
const RIEUL_INITIAL = 5;
const NIEUN_FINAL = 4;
const RIEUL_FINAL = 8;

const isHangul = (ch: string) => ch >= '가' && ch <= '힣';

/** 한글 낱말 하나를 로마자로. 한글이 아닌 글자(숫자·영문)는 그대로 둔다 */
export function romanize(text: string): string {
  let out = '';
  let prevFinal = -1;
  for (const ch of text) {
    if (!isHangul(ch)) {
      out += ch;
      prevFinal = -1;
      continue;
    }
    const code = ch.charCodeAt(0) - 0xac00;
    const ini = Math.floor(code / 588);
    const med = Math.floor((code % 588) / 28);
    const fin = code % 28;
    if (ini === RIEUL_INITIAL && (prevFinal === NIEUN_FINAL || prevFinal === RIEUL_FINAL)) {
      out = out.slice(0, -1) + 'll';
    } else {
      out += INITIAL[ini];
    }
    out += MEDIAL[med]! + FINAL[fin]!;
    prevFinal = fin;
  }
  return out
    .split(' ')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// 한글이 들어간 이름 한 덩어리: "제3해진호", "부산 남쪽 바다", "신선대부두"
const HANGUL_NAME = /[0-9A-Za-z]*[가-힣][가-힣0-9]*(?: [가-힣][가-힣0-9]*)*/gu;

/** 글 안의 한글 이름마다 읽는 법을 덧붙인다: "[동방호 / 공방호]" → "[동방호 (Dongbangho) / 공방호 (Gongbangho)]" */
export function withRoman(text: string): string {
  return text.replace(HANGUL_NAME, (name) => `${name} (${romanize(name)})`);
}
