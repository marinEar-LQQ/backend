import type { AudioFlag, AudioFrame, GapEvent } from '../../contracts';
import { concat, rms } from './dsp';

/**
 * 수신 프레임 → 순서/누락 검사 → 발화 구간 분리 (에너지 기반 VAD).
 * 원음은 원래 sampleRate 그대로 잘라 넘긴다 (리샘플링은 다음 단계).
 * 초기 수치는 실측 후 조정한다 (백엔드 02장).
 */

export interface SegmenterOptions {
  windowMs: number;
  preRollMs: number;
  hangoverMs: number;
  maxUtteranceMs: number;
  minSpeechMs: number;
  /** 잡음 바닥 대비 시작 배수 */
  onRatio: number;
  offRatio: number;
  minThreshold: number;
}

export const DEFAULT_SEGMENTER: SegmenterOptions = {
  windowMs: 30,
  preRollMs: 300,
  hangoverMs: 500, // 팀 잡음 녹음 실측으로 조정 (2026-11-27): 700→500
  maxUtteranceMs: 20000,
  minSpeechMs: 250,
  onRatio: 3.0,
  offRatio: 2.5, // 1.8 은 잡음이 계속 깔린 녹음에서 말 끝을 못 찾아 20초 강제 절단됨
  minThreshold: 0.006,
};

export interface SegmentedUtterance {
  startMs: number;
  endMs: number;
  sampleRate: number;
  pcm: Float32Array;
  flags: AudioFlag[];
}

export interface PushResult {
  gaps: GapEvent[];
  utterances: SegmentedUtterance[];
}

interface Window {
  pcm: Float32Array;
  startMs: number;
  rms: number;
}

export class Segmenter {
  private readonly o: SegmenterOptions;
  private sampleRate: number | null = null;
  private expectedSeq = 0;
  private expectedMs: number | null = null;
  private carry: Float32Array = new Float32Array(0);
  private carryStartMs = 0;
  private noiseFloor: number | null = null;
  /** 최근 rms 기록 (최소 통계 방식 잡음 바닥 추정, 발화 중에도 갱신) */
  private recentRms: number[] = [];
  private preRoll: Window[] = [];
  private current: Window[] | null = null;
  private currentFlags = new Set<AudioFlag>();
  private silenceRunMs = 0;
  private speechMs = 0;

  constructor(opts: Partial<SegmenterOptions> = {}, private readonly now: () => string = () => new Date().toISOString()) {
    this.o = { ...DEFAULT_SEGMENTER, ...opts };
  }

  get currentNoiseFloor(): number | null {
    return this.noiseFloor;
  }

  push(frame: AudioFrame): PushResult {
    const gaps: GapEvent[] = [];
    const utterances: SegmentedUtterance[] = [];

    if (this.sampleRate !== null && frame.sampleRate !== this.sampleRate) {
      // 입력 규격이 바뀌면 현재 발화를 닫고 새로 시작
      utterances.push(...this.flush());
      this.carry = new Float32Array(0);
    }
    this.sampleRate = frame.sampleRate;

    // 순서/누락 검사
    if (frame.seq !== this.expectedSeq || (this.expectedMs !== null && frame.startMs - this.expectedMs > this.o.windowMs * 2)) {
      if (frame.seq > this.expectedSeq || (this.expectedMs !== null && frame.startMs > this.expectedMs)) {
        const gap: GapEvent = {
          reason: 'AUDIO_GAP',
          startMs: this.expectedMs ?? frame.startMs,
          endMs: frame.startMs,
          at: this.now(),
          ...(frame.seq > this.expectedSeq ? { missingSeq: { from: this.expectedSeq, to: frame.seq - 1 } } : {}),
        };
        gaps.push(gap);
        if (this.current) this.currentFlags.add('AUDIO_GAP');
        // 누락 구간을 소리로 채우지 않는다: 남은 조각은 버리고 시간 기준을 새 프레임에 맞춘다
        this.carry = new Float32Array(0);
      }
    }
    this.expectedSeq = frame.seq + 1;
    const frameDurMs = (frame.pcm.length / frame.sampleRate) * 1000;
    this.expectedMs = frame.startMs + frameDurMs;

    if (this.carry.length === 0) this.carryStartMs = frame.startMs;
    this.carry = concat([this.carry, frame.pcm]);

    const winLen = Math.round((this.o.windowMs / 1000) * frame.sampleRate);
    let offset = 0;
    while (this.carry.length - offset >= winLen) {
      const pcm = this.carry.slice(offset, offset + winLen);
      const startMs = this.carryStartMs + (offset / frame.sampleRate) * 1000;
      const u = this.processWindow({ pcm, startMs, rms: rms(pcm) });
      if (u) utterances.push(u);
      offset += winLen;
    }
    this.carry = this.carry.slice(offset);
    this.carryStartMs += (offset / frame.sampleRate) * 1000;
    return { gaps, utterances };
  }

  /** 세션 종료 시 진행 중 발화를 닫는다 */
  flush(): SegmentedUtterance[] {
    const out: SegmentedUtterance[] = [];
    if (this.current) {
      const u = this.finish();
      if (u) out.push(u);
    }
    return out;
  }

  private threshold(ratio: number): number {
    return Math.max(this.o.minThreshold, (this.noiseFloor ?? this.o.minThreshold) * ratio);
  }

  private processWindow(w: Window): SegmentedUtterance | null {
    // 잡음 바닥 = 최근 약 3초 rms 의 최솟값 (단어 사이 쉼에서 잡음만 측정됨)
    this.recentRms.push(w.rms);
    const maxHist = Math.ceil(3000 / this.o.windowMs);
    if (this.recentRms.length > maxHist) this.recentRms.shift();
    if (this.recentRms.length >= 5) this.noiseFloor = Math.max(1e-4, Math.min(...this.recentRms));

    if (!this.current) {
      if (w.rms > this.threshold(this.o.onRatio) && this.noiseFloor !== null) {
        this.current = [...this.preRoll, w];
        this.preRoll = [];
        this.currentFlags = new Set();
        this.silenceRunMs = 0;
        this.speechMs = this.o.windowMs;
        return null;
      }
      this.preRoll.push(w);
      const maxPre = Math.ceil(this.o.preRollMs / this.o.windowMs);
      if (this.preRoll.length > maxPre) this.preRoll.shift();
      return null;
    }

    this.current.push(w);
    if (w.rms < this.threshold(this.o.offRatio)) {
      this.silenceRunMs += this.o.windowMs;
    } else {
      this.silenceRunMs = 0;
      this.speechMs += this.o.windowMs;
    }
    const durMs = this.current.length * this.o.windowMs;
    if (this.silenceRunMs >= this.o.hangoverMs) return this.finish();
    if (durMs >= this.o.maxUtteranceMs) {
      this.currentFlags.add('TRUNCATED');
      return this.finish();
    }
    return null;
  }

  private finish(): SegmentedUtterance | null {
    const windows = this.current!;
    this.current = null;
    // 뒤쪽 무음은 300ms 만 남긴다
    const keepTail = Math.ceil(300 / this.o.windowMs);
    const trailing = Math.floor(this.silenceRunMs / this.o.windowMs);
    const cut = Math.max(0, trailing - keepTail);
    const used = cut > 0 ? windows.slice(0, windows.length - cut) : windows;
    this.preRoll = windows.slice(-Math.ceil(this.o.preRollMs / this.o.windowMs));
    if (this.speechMs < this.o.minSpeechMs || used.length === 0) return null;

    const pcm = concat(used.map((w) => w.pcm));
    let clipped = 0;
    for (let i = 0; i < pcm.length; i++) if (Math.abs(pcm[i]!) >= 0.99) clipped++;
    if (clipped / pcm.length > 0.001) this.currentFlags.add('CLIPPING');

    const first = used[0]!;
    const last = used[used.length - 1]!;
    return {
      startMs: Math.round(first.startMs),
      endMs: Math.round(last.startMs + this.o.windowMs),
      sampleRate: this.sampleRate!,
      pcm,
      flags: [...this.currentFlags],
    };
  }
}
