import { resample } from './dsp';

/**
 * RNNoise (Xiph, BSD-3 / @shiguredo/rnnoise-wasm Apache-2.0) 어댑터.
 * Jitsi·OBS 등에서 쓰는 오픈소스 실시간 잡음 제거. 48 kHz, 480 샘플 프레임, 16bit 스케일 입력.
 * 원음은 바꾸지 않고 새 배열을 돌려준다.
 */

export const RNNOISE_VERSION = 'rnnoise-wasm-2025.1.5';

type RnnoiseModule = typeof import('@shiguredo/rnnoise-wasm');
type RnnoiseInstance = Awaited<ReturnType<RnnoiseModule['Rnnoise']['load']>>;

let loader: Promise<RnnoiseInstance> | null = null;
export function loadRnnoise(): Promise<RnnoiseInstance> {
  loader ??= import('@shiguredo/rnnoise-wasm').then((m) => m.Rnnoise.load());
  return loader;
}

export interface RnnoiseResult {
  pcm: Float32Array;
  /** 프레임(10ms)별 음성 확률 0~1 — 발화 구간 판단 보조에 쓸 수 있다 */
  vad: Float32Array;
}

export async function rnnoiseDenoise(pcm: Float32Array, sampleRate: number): Promise<RnnoiseResult> {
  const rn = await loadRnnoise();
  const state = rn.createDenoiseState();
  try {
    const up = sampleRate === 48000 ? pcm.slice() : resample(pcm, sampleRate, 48000);
    const n = rn.frameSize;
    const frames = Math.ceil(up.length / n);
    const out = new Float32Array(frames * n);
    const vad = new Float32Array(frames);
    const frame = new Float32Array(n);
    for (let f = 0; f < frames; f++) {
      frame.fill(0);
      for (let i = 0; i < n && f * n + i < up.length; i++) frame[i] = up[f * n + i]! * 32768;
      vad[f] = state.processFrame(frame);
      for (let i = 0; i < n; i++) out[f * n + i] = frame[i]! / 32768;
    }
    const trimmed = out.subarray(0, up.length);
    return { pcm: sampleRate === 48000 ? trimmed.slice() : resample(trimmed, 48000, sampleRate), vad };
  } finally {
    state.destroy();
  }
}
