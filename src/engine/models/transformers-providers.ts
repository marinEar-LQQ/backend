import type { LangCode, LoadProgress, ModelManifest, Transcript, TranscriptSegment } from '../../contracts';
import type { AsrContext, AsrProvider, TranslationProvider } from '../providers';

/**
 * transformers.js (ONNX Runtime Web) 기반 실제 모델 provider.
 * 라이브러리는 동적 import 로 불러와, Mock 만 쓰는 화면 개발에는 번들되지 않게 한다.
 * UI 가 모델 라이브러리를 직접 호출하지 않는다 (프론트 01장) — 이 파일은 Worker 안에서만 쓰인다.
 */

type TF = typeof import('@huggingface/transformers');
let tfPromise: Promise<TF> | null = null;
export function loadTransformers(): Promise<TF> {
  tfPromise ??= import('@huggingface/transformers');
  return tfPromise;
}

export type Device = 'webgpu' | 'wasm';

/**
 * 기본은 WASM. 실측(2026-11-27, RTX 4050 노트북, whisper-small): Chrome WASM 멀티스레드 발화당 9.8s,
 * Edge WebGPU(fp32 encoder + q4 decoder) 20.5s — WebGPU 가 더 느렸다. WebGPU 는 명시적으로 고를 때만.
 */
export async function pickDevice(): Promise<Device> {
  return 'wasm';
}

/** navigator.gpu 가 있어도 어댑터가 없을 수 있다 (GPU 차단 기기) — 실제로 요청해 보고 판단 */
export async function webgpuAvailable(): Promise<Device> {
  const gpu = typeof navigator !== 'undefined' ? (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu : undefined;
  if (!gpu) return 'wasm';
  try {
    return (await gpu.requestAdapter()) ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

export interface RuntimeOptions {
  device?: Device;
  /** false 면 네트워크에서 모델을 받지 않는다 (오프라인 검증) */
  allowRemote: boolean;
  /** 자체 호스팅 모델 경로 (예: '/models/'). 지정 시 로컬 경로 우선 */
  localModelPath?: string;
}

type EnvFetch = (input: string | URL, init?: unknown) => Promise<unknown>;
let originalFetch: EnvFetch | null = null;

/**
 * 오프라인 모드: 외부 주소로 나가는 요청을 막는다 (캐시에 있는 모델만 사용).
 * transformers.js 는 allowRemoteModels=false + allowLocalModels=false 조합을 거부하므로,
 * 라이브러리 설정은 "원격 허용(캐시 우선)"으로 두고 라이브러리의 env.fetch 를 감싸 실제 인터넷 끊김과 같게 만든다.
 * (globalThis.fetch 를 바꾸면 안 된다 — 라이브러리가 로드 시점에 fetch 를 잡아 env.fetch 로 쓴다)
 */
function setOfflineGuard(env: { fetch: EnvFetch }, on: boolean): void {
  if (on && !originalFetch) {
    originalFetch = env.fetch;
    const own = typeof location !== 'undefined' ? location.origin : null;
    env.fetch = (input, init) => {
      const target = new URL(String(input), own ?? undefined);
      if (target.protocol.startsWith('http') && (!own || target.origin !== own)) {
        return Promise.reject(new TypeError(`오프라인 모드: 원격 요청 차단 (${target.host})`));
      }
      return originalFetch!(input, init);
    };
  } else if (!on && originalFetch) {
    env.fetch = originalFetch;
    originalFetch = null;
  }
}

export async function configureRuntime(opts: RuntimeOptions): Promise<void> {
  const { env } = await loadTransformers();
  env.allowRemoteModels = true;
  setOfflineGuard(env as unknown as { fetch: EnvFetch }, !opts.allowRemote);
  env.useBrowserCache = true;
  if (opts.localModelPath) {
    env.allowLocalModels = true;
    env.localModelPath = opts.localModelPath;
  } else {
    env.allowLocalModels = false;
  }
}

function progressAdapter(modelId: string, onProgress?: (p: LoadProgress) => void) {
  const files = new Map<string, { loaded: number; total: number }>();
  return (info: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (!onProgress) return;
    if (info.status === 'progress' && info.file) files.set(info.file, { loaded: info.loaded ?? 0, total: info.total ?? 0 });
    const loaded = [...files.values()].reduce((n, f) => n + f.loaded, 0);
    const total = [...files.values()].reduce((n, f) => n + f.total, 0);
    onProgress({ modelId, loadedBytes: loaded, totalBytes: total || null, status: info.status === 'ready' ? 'ready' : 'downloading' });
  };
}

// 무음·잡음에서 Whisper 가 자주 지어내는 문장. 실제 교신으로 보이지 않게 제거한다.
const HALLUCINATIONS = [
  /시청(해)?\s*주셔서\s*감사합니다\.?/g,
  /구독과\s*좋아요[^.]*\.?/g,
  /MBC\s*뉴스[^.]*\.?/g,
  /자막\s*제공[^.]*\.?/g,
  /thank(s| you)( so much)? for watching[.!]*/gi,
  /please subscribe[^.!]*[.!]*/gi,
];

export function cleanTranscript(text: string): string {
  let t = text;
  for (const re of HALLUCINATIONS) t = t.replace(re, '');
  return collapseRepeats(t).text.replace(/\s+/g, ' ').trim();
}

/**
 * 반복 환각 제거: 같은 구절이 4번 이상 연달아 나오면 한 번만 남기고 표시한다.
 * ("도시의 도시의 도시의 …" — Whisper 디코더가 반복 루프에 빠진 경우). "부산 VTS, 부산 VTS" 같은 2회 호출은 유지.
 */
export function collapseRepeats(text: string): { text: string; collapsed: boolean } {
  let collapsed = false;
  const out = text.replace(/(\S.{0,30}?)(?:[\s,.]*\1){3,}/gu, (_m, unit: string) => {
    collapsed = true;
    return `${unit} [반복 인식 생략]`;
  });
  return { text: out, collapsed };
}

/** 발화 길이 대비 글자 수가 너무 적으면(영어 교신을 한국어로 강제 인식한 경우 등) 언어 자동 감지로 다시 인식 */
export function looksTruncated(text: string, seconds: number): boolean {
  const visible = text.replace(/[\s.,…?!]/g, '').length;
  return seconds >= 4 && visible < seconds * 2.5;
}

// ───────────────────────── ASR (Whisper) ─────────────────────────

type AsrPipeline = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string; chunks?: Array<{ timestamp: [number, number | null]; text: string }> }>;

export class WhisperAsr implements AsrProvider {
  readonly sampleRate = 16000 as const;
  private constructor(
    private readonly pipe: AsrPipeline,
    readonly modelVersion: string,
  ) {}

  static async create(model: ModelManifest, device: Device, onProgress?: (p: LoadProgress) => void): Promise<WhisperAsr> {
    const { pipeline } = await loadTransformers();
    const dtype = device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : { encoder_model: 'q8', decoder_model_merged: 'q8' };
    const pipe = (await pipeline('automatic-speech-recognition', model.modelId, {
      device,
      dtype: dtype as never,
      progress_callback: progressAdapter(model.modelId, onProgress) as never,
    })) as unknown as AsrPipeline;
    return new WhisperAsr(pipe, `${model.modelId}@${model.version}/${device}`);
  }

  async transcribe(pcm16k: Float32Array, ctx: AsrContext): Promise<Transcript> {
    const seconds = pcm16k.length / 16000;
    // 생성 길이 상한: 반복 루프에 빠져도 발화 길이에 비례한 시간 안에 끝나게 한다
    const base = { task: 'transcribe', return_timestamps: true, chunk_length_s: 30, max_new_tokens: Math.min(400, Math.ceil(seconds * 20) + 16) };
    let out = await this.pipe(pcm16k, { ...base, language: 'korean' });
    if (looksTruncated(out.text, seconds)) {
      // 영어 교신(Busan VTS, this is …)은 한국어 강제 시 잘려 나온다 → 언어 자동 감지로 재시도해 더 긴 쪽 채택
      // 영어로 다시 인식. 환각을 걷어낸 뒤에도 충분히 길고 실제 영어 문장일 때만 채택
      const en = await this.pipe(pcm16k, { ...base, language: 'english' });
      const enClean = cleanTranscript(en.text);
      const latin = (enClean.match(/[A-Za-z]/g) ?? []).length / Math.max(1, enClean.replace(/\s/g, '').length);
      if (latin > 0.6 && enClean.replace(/\s/g, '').length > cleanTranscript(out.text).replace(/\s/g, '').length * 1.5) out = { ...en, text: enClean };
    }
    const durMs = Math.round(seconds * 1000);
    const chunks = out.chunks?.length ? out.chunks : [{ timestamp: [0, durMs / 1000] as [number, number], text: out.text }];
    const segments: TranscriptSegment[] = chunks
      .map((c, i) => ({
        segmentId: `${ctx.utteranceId}-${ctx.variant}-${i}`,
        text: cleanTranscript(c.text),
        startMs: ctx.utteranceStartMs + Math.round((c.timestamp[0] ?? 0) * 1000),
        endMs: ctx.utteranceStartMs + Math.round((c.timestamp[1] ?? durMs / 1000) * 1000),
        confidence: null, // Whisper pipeline 은 신뢰도를 주지 않는다 — 임의로 만들지 않음
      }))
      .filter((s) => s.text.length > 0);
    return {
      text: segments.map((s) => s.text).join(' '),
      segments,
      modelVersion: this.modelVersion,
      wordAligned: false,
    };
  }
}

// ───────────────────────── 번역 (M2M100) ─────────────────────────

/** 공통 언어 코드 → M2M100 코드 (fil 은 tl 로 학습됨) */
const M2M_CODE: Partial<Record<LangCode, string>> = { ko: 'ko', en: 'en', id: 'id', my: 'my', vi: 'vi', fil: 'tl' };

type TranslatePipeline = (text: string, opts: Record<string, unknown>) => Promise<Array<{ translation_text: string }>>;

export class M2M100Translator implements TranslationProvider {
  private constructor(
    private readonly pipe: TranslatePipeline,
    readonly modelVersion: string,
    private readonly langs: LangCode[],
  ) {}

  static async create(model: ModelManifest, device: Device, onProgress?: (p: LoadProgress) => void): Promise<M2M100Translator> {
    const { pipeline } = await loadTransformers();
    // 번역은 q8 CPU 계열로 고정 (WebGPU 는 쓰지 않음). 브라우저=wasm, Node 평가=cpu
    const pipe = (await pipeline('translation', model.modelId, {
      device: device === 'webgpu' ? 'wasm' : device,
      dtype: 'q8' as never,
      progress_callback: progressAdapter(model.modelId, onProgress) as never,
    })) as unknown as TranslatePipeline;
    const langs = model.languages.filter((l) => l !== 'ko' && M2M_CODE[l]);
    return new M2M100Translator(pipe, `${model.modelId}@${model.version}`, langs);
  }

  supports(target: LangCode): boolean {
    return this.langs.includes(target);
  }

  async translate(text: string, target: LangCode): Promise<string> {
    const out = await this.pipe(text, { src_lang: 'ko', tgt_lang: M2M_CODE[target], max_new_tokens: 256 });
    return out[0]?.translation_text ?? '';
  }
}
