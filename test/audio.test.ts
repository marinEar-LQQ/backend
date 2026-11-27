import { describe, expect, it } from 'vitest';
import type { AudioFrame } from '../src/contracts';
import { decodeWav, encodeWav, resample, rms } from '../src/engine/audio/dsp';
import { enhanceSpeech } from '../src/engine/audio/enhance';
import { Segmenter } from '../src/engine/audio/segmenter';

function tone(freq: number, ms: number, sr: number, amp = 0.3): Float32Array {
  const n = Math.round((ms / 1000) * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

function noise(ms: number, sr: number, amp: number, seed = 1): Float32Array {
  const n = Math.round((ms / 1000) * sr);
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = amp * ((s / 0x7fffffff) * 2 - 1);
  }
  return out;
}

function frames(pcm: Float32Array, sr: number, frameMs = 20): AudioFrame[] {
  const len = Math.round((frameMs / 1000) * sr);
  const out: AudioFrame[] = [];
  for (let i = 0, seq = 0; i < pcm.length; i += len, seq++) {
    out.push({ sessionId: 's', seq, startMs: (i / sr) * 1000, sampleRate: sr, channels: 1, pcm: pcm.slice(i, i + len) });
  }
  return out;
}

describe('dsp', () => {
  it('48k → 16k 리샘플링: 길이와 음성 대역 톤 보존', () => {
    const x = tone(1000, 500, 48000);
    const y = resample(x, 48000, 16000);
    expect(y.length).toBe(8000);
    expect(rms(y, 1000, 7000)).toBeCloseTo(0.3 / Math.SQRT2, 1);
  });

  it('다운샘플 시 나이퀴스트 위 성분은 제거', () => {
    const y = resample(tone(12000, 500, 48000), 48000, 16000);
    expect(rms(y, 1000, 7000)).toBeLessThan(0.02);
  });

  it('WAV 인코딩/디코딩 왕복', () => {
    const x = tone(440, 100, 16000);
    const { pcm, sampleRate } = decodeWav(encodeWav(x, 16000));
    expect(sampleRate).toBe(16000);
    expect(pcm.length).toBe(x.length);
    expect(Math.abs(pcm[100]! - x[100]!)).toBeLessThan(1e-3);
  });
});

describe('잡음 완화', () => {
  it('정상 잡음 구간 대비 음성 구간 비율(SNR)이 개선된다', () => {
    const sr = 16000;
    const n = noise(3000, sr, 0.05);
    const speech = tone(800, 1000, sr, 0.2);
    const x = n.slice();
    for (let i = 0; i < speech.length; i++) x[sr + i]! += speech[i]!;
    const y = enhanceSpeech(x, sr);
    const snr = (sig: Float32Array) => rms(sig, sr + 2000, 2 * sr - 2000) / rms(sig, 2000, sr - 2000);
    expect(snr(y)).toBeGreaterThan(snr(x) * 2);
    expect(y.length).toBe(x.length);
  });
});

describe('Segmenter (VAD·누락)', () => {
  const sr = 48000;
  it('두 번의 송신을 두 발화로 분리하고 시간축을 유지', () => {
    const pcm = new Float32Array(
      [...noise(1000, sr, 0.003), ...tone(600, 1200, sr), ...noise(1500, sr, 0.003, 7), ...tone(900, 800, sr), ...noise(1500, sr, 0.003, 9)],
    );
    const seg = new Segmenter();
    const utts = frames(pcm, sr).flatMap((f) => seg.push(f).utterances).concat(seg.flush());
    expect(utts).toHaveLength(2);
    expect(utts[0]!.startMs).toBeGreaterThanOrEqual(650);
    expect(utts[0]!.startMs).toBeLessThanOrEqual(1000);
    expect(utts[1]!.startMs).toBeGreaterThan(3000);
    expect(utts[0]!.sampleRate).toBe(48000);
  });

  it('seq 누락을 AUDIO_GAP 으로 기록하고 발화에 표시', () => {
    const pcm = new Float32Array([...noise(500, sr, 0.003), ...tone(600, 1500, sr), ...noise(1500, sr, 0.003)]);
    const fs = frames(pcm, sr);
    fs.splice(40, 3); // 발화 중 60ms 누락
    const seg = new Segmenter();
    const results = fs.map((f) => seg.push(f));
    const gaps = results.flatMap((r) => r.gaps);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.missingSeq).toEqual({ from: 40, to: 42 });
    const utts = results.flatMap((r) => r.utterances).concat(seg.flush());
    expect(utts[0]!.flags).toContain('AUDIO_GAP');
  });

  it('긴 무음만 있으면 발화 없음', () => {
    const seg = new Segmenter();
    const utts = frames(noise(5000, sr, 0.002), sr).flatMap((f) => seg.push(f).utterances).concat(seg.flush());
    expect(utts).toHaveLength(0);
  });
});
