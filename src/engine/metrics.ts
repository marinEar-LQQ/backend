import type { AnyEngineEvent, AnalysisResult, Utterance } from '../contracts';

/**
 * 실행 성능 측정 (백엔드 07장): 발화별 처리 시간, 발화 종료→최종 결과 지연 p50/p95, RTF.
 * RTF = 처리 시간 / 음성 길이. 1 미만이면 음성보다 빠르게 처리.
 * 파일 분석은 프레임을 한꺼번에 보내므로 "종료→최종"에는 대기열 시간이 포함된다 — 처리 시간과 분리해 보고한다.
 */

export interface UtteranceTiming {
  utteranceId: string;
  audioMs: number;
  queuedAt: number;
  startedAt: number | null;
  rev1At: number | null;
  finalAt: number | null;
}

export interface PerfSummary {
  count: number;
  audioSeconds: number;
  /** 처리 시작(enhancing) → 최종(rev2) */
  processingMs: { p50: number; p95: number; max: number };
  /** 대기열 진입(발화 종료 직후) → 최종(rev2) */
  endToFinalMs: { p50: number; p95: number; max: number };
  /** 대기열 진입 → 첫 결과(rev1, enhanced 만) */
  endToFirstMs: { p50: number; p95: number; max: number };
  rtf: { mean: number; max: number };
}

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

const stat = (xs: number[]) => ({ p50: pct(xs, 50), p95: pct(xs, 95), max: xs.length ? Math.max(...xs) : NaN });

export class PerfRecorder {
  private readonly t = new Map<string, UtteranceTiming>();

  constructor(private readonly clock: () => number = () => performance.now()) {}

  onEvent(e: AnyEngineEvent): void {
    const now = this.clock();
    if (e.type === 'analysis.progress') {
      const p = e.payload as { stage: string; utterance?: Utterance };
      if (p.stage === 'queued' && p.utterance) {
        this.t.set(p.utterance.utteranceId, { utteranceId: p.utterance.utteranceId, audioMs: p.utterance.endMs - p.utterance.startMs, queuedAt: now, startedAt: null, rev1At: null, finalAt: null });
      } else if (p.stage === 'enhancing' && e.utteranceId) {
        const x = this.t.get(e.utteranceId);
        if (x) x.startedAt = now;
      }
    } else if (e.type === 'analysis.final') {
      const r = (e.payload as { result: AnalysisResult }).result;
      const x = this.t.get(r.utteranceId);
      if (!x) return;
      if (r.revision === 1) x.rev1At = now;
      if (r.crossCheck !== 'pending') x.finalAt = now;
    }
  }

  timings(): UtteranceTiming[] {
    return [...this.t.values()];
  }

  summary(): PerfSummary {
    const done = this.timings().filter((x) => x.finalAt !== null && x.startedAt !== null);
    const proc = done.map((x) => x.finalAt! - x.startedAt!);
    const rtf = done.map((x) => (x.finalAt! - x.startedAt!) / Math.max(1, x.audioMs));
    return {
      count: done.length,
      audioSeconds: done.reduce((n, x) => n + x.audioMs, 0) / 1000,
      processingMs: stat(proc),
      endToFinalMs: stat(done.map((x) => x.finalAt! - x.queuedAt)),
      endToFirstMs: stat(done.filter((x) => x.rev1At).map((x) => x.rev1At! - x.queuedAt)),
      rtf: { mean: rtf.reduce((a, b) => a + b, 0) / Math.max(1, rtf.length), max: rtf.length ? Math.max(...rtf) : NaN },
    };
  }
}
