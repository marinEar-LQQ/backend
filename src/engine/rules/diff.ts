import type { WordDiff } from '../../contracts';

/**
 * 원음/완화음 자막의 단어 단위 차이 (추가 기능 ②: 인식 차이 표시).
 * 띄어쓰기 단위로 자르고, 문장부호·대소문자를 무시한 채 LCS 로 맞춘다.
 * 'changed' 는 같은 자리에서 다르게 들린 단어 — 화면에서 "확인 필요" 강조 대상.
 */

const norm = (w: string) => w.toUpperCase().replace(/[.,?!…·:;'"()[\]]/g, '');

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
