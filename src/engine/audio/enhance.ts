import { biquad, fft, peak } from './dsp';

/**
 * 로컬 잡음 완화 (모델 없음): VHF 음성 대역 필터 + 스펙트럼 게이트.
 *  1) 300–3400 Hz 대역 통과 (무전 음성 대역 밖 험·고역 잡음 제거)
 *  2) STFT 후 bin 별 잡음 바닥을 추정해 그만큼 감쇄 (spectral gating)
 *  3) 피크 정규화 (최대 10배)
 * 결과는 별도 파생 음성이며 원음은 바꾸지 않는다. 잘린 말·왜곡을 "복원"하지 않는다.
 */

export const ENHANCER_VERSION = 'bandpass-specgate-v1';

export interface EnhanceOptions {
  lowHz?: number;
  highHz?: number;
  /** 잡음 추정 백분위 (0~1) */
  noisePercentile?: number;
  overSubtract?: number;
  gainFloor?: number;
  /** 세션 단위로 미리 추정한 잡음 스펙트럼 (bin 별 크기). 없으면 발화 안에서 추정 */
  noiseProfile?: Float64Array;
}

const N = 512;
const HOP = 128;

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}
const WIN = hann(N);

export function bandpass(pcm: Float32Array, sampleRate: number, lowHz = 300, highHz = 3400): Float32Array {
  let x = biquad(pcm, sampleRate, 'highpass', lowHz);
  x = biquad(x, sampleRate, 'highpass', lowHz);
  const hi = Math.min(highHz, sampleRate / 2 - 100);
  x = biquad(x, sampleRate, 'lowpass', hi);
  x = biquad(x, sampleRate, 'lowpass', hi);
  return x;
}

/** STFT 크기 스펙트럼 (프레임 × bin) */
export function magnitudeFrames(pcm: Float32Array): Float64Array[] {
  const frames: Float64Array[] = [];
  for (let start = 0; start + N <= pcm.length; start += HOP) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = pcm[start + i]! * WIN[i]!;
    fft(re, im);
    const mag = new Float64Array(N / 2 + 1);
    for (let k = 0; k <= N / 2; k++) mag[k] = Math.hypot(re[k]!, im[k]!);
    frames.push(mag);
  }
  return frames;
}

export function estimateNoise(frames: Float64Array[], percentile = 0.2): Float64Array {
  const bins = N / 2 + 1;
  const out = new Float64Array(bins);
  if (frames.length === 0) return out;
  const col = new Float64Array(frames.length);
  for (let k = 0; k < bins; k++) {
    for (let f = 0; f < frames.length; f++) col[f] = frames[f]![k]!;
    col.sort();
    out[k] = col[Math.min(col.length - 1, Math.floor(percentile * col.length))]!;
  }
  return out;
}

export function enhanceSpeech(pcm: Float32Array, sampleRate: number, opts: EnhanceOptions = {}): Float32Array {
  const band = bandpass(pcm, sampleRate, opts.lowHz, opts.highHz);
  if (band.length < N) return normalize(band);

  // 앞뒤를 반 창만큼 패딩해 경계 손실 방지
  const padded = new Float32Array(band.length + 2 * N);
  padded.set(band, N);

  const frames = magnitudeFrames(padded);
  const noise = opts.noiseProfile ?? estimateNoise(frames, opts.noisePercentile ?? 0.2);
  const alpha = opts.overSubtract ?? 1.5;
  const floor = opts.gainFloor ?? 0.12;

  const out = new Float64Array(padded.length);
  const norm = new Float64Array(padded.length);
  const prevGain = new Float64Array(N / 2 + 1).fill(1);

  let fi = 0;
  for (let start = 0; start + N <= padded.length; start += HOP, fi++) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = padded[start + i]! * WIN[i]!;
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) {
      const mag = Math.hypot(re[k]!, im[k]!) + 1e-12;
      let g = Math.max(floor, 1 - (alpha * noise[k]!) / mag);
      g = 0.6 * g + 0.4 * prevGain[k]!; // 시간 방향 평활 (뮤지컬 노이즈 완화)
      prevGain[k] = g;
      re[k] = re[k]! * g;
      im[k] = im[k]! * g;
      if (k > 0 && k < N / 2) {
        re[N - k] = re[k]!;
        im[N - k] = -im[k]!;
      }
    }
    fft(re, im, true);
    for (let i = 0; i < N; i++) {
      out[start + i] = out[start + i]! + re[i]! * WIN[i]!;
      norm[start + i] = norm[start + i]! + WIN[i]! * WIN[i]!;
    }
  }
  const result = new Float32Array(band.length);
  for (let i = 0; i < band.length; i++) {
    const n = norm[i + N]!;
    result[i] = n > 1e-8 ? out[i + N]! / n : 0;
  }
  return normalize(result);
}

function normalize(x: Float32Array): Float32Array {
  const p = peak(x);
  if (p < 1e-6) return x;
  const g = Math.min(10, 0.9 / p);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i]! * g;
  return out;
}
