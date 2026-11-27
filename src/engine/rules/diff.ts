import type { WordDiff } from '../../contracts';
import { sinoDigits } from './extract';

/**
 * 원음/완화음 자막의 단어 단위 차이 (추가 기능 ②: 인식 차이 표시).
 * 띄어쓰기 단위로 자르고, 문장부호·대소문자를 무시한 채 LCS 로 맞춘다.
 * 'changed' 는 같은 자리에서 다르게 들린 단어 — 화면에서 "확인 필요" 강조 대상.
 */

const norm = (w: string) => w.toUpperCase().replace(/[.,?!…·:;'"()[\]]/g, '');

const NATIVE: Record<string, number> = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 열한: 11, 열두: 12 };

/**
 * 숫자 표기만 다른 묶음을 같은 것으로 보기 위한 정규화: 띄어쓰기를 없애고 단위 앞 한글 숫자를 아라비아 숫자로.
 * 실측: 원음 "12노트 … 2시 30분" / 완화음 "십이 노트 … 두 시 삼십 분" — 뜻은 같은데 10곳이 "다르게 들림"으로 표시됨
 */
function numberNorm(words: string[]): string {
  const s = norm(words.join(''))
    .replace(/(열한|열두|다섯|여섯|일곱|여덟|아홉|한|두|세|네|열)(?=시|번)/gu, (w) => String(NATIVE[w]))
    .replace(/([공영일이삼사오육칠팔구십백]{1,5})(?=노트|분|번|시|마일|미터|도)/gu, (w) => sinoDigits(w) ?? w)
    .replace(/미터/gu, 'M') // "육십 미터" ↔ "60m" (norm 이 대문자로 바꿈)
    .replace(/킬로미터|킬로/gu, 'KM');
  // 단위가 다음 단어로 떨어져 숫자만 남은 묶음 ("팔" ↔ "8", 화면 실측). 조사로도 쓰이는 "이" 한 글자는 제외
  return /^[공영일이삼사오육칠팔구십백]{1,5}$/u.test(s) && s !== '이' ? (sinoDigits(s) ?? s) : s;
}

export function diffTranscripts(raw: string, enhanced: string): WordDiff[] {
  const a = raw.split(/\s+/).filter(Boolean);
  const b = enhanced.split(/\s+/).filter(Boolean);
  const an = a.map(norm);
  const bn = b.map(norm);
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = an[i] === bn[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: WordDiff[] = [];
  const pendingRaw: string[] = [];
  const pendingEnh: string[] = [];
  const flush = () => {
    // 숫자 표기만 다른 묶음("12노트" ↔ "십이 노트")은 한 단위의 'same' 으로
    if (pendingRaw.length && pendingEnh.length && numberNorm(pendingRaw) === numberNorm(pendingEnh)) {
      ops.push({ op: 'same', raw: pendingRaw.join(' '), enhanced: pendingEnh.join(' ') });
      pendingRaw.length = 0;
      pendingEnh.length = 0;
      return;
    }
    // 같은 자리에서 빠지고 들어온 단어들은 짝지어 'changed' 로
    const n = Math.max(pendingRaw.length, pendingEnh.length);
    for (let k = 0; k < n; k++) {
      const r = pendingRaw[k] ?? null;
      const e = pendingEnh[k] ?? null;
      ops.push({ op: r && e ? 'changed' : r ? 'removed' : 'added', raw: r, enhanced: e });
    }
    pendingRaw.length = 0;
    pendingEnh.length = 0;
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && an[i] === bn[j]) {
      flush();
      ops.push({ op: 'same', raw: a[i]!, enhanced: b[j]! });
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      pendingEnh.push(b[j]!);
      j++;
    } else {
      pendingRaw.push(a[i]!);
      i++;
    }
  }
  flush();
  return ops;
}
