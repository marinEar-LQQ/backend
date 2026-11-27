import type { AudioVariant, LangCode, LoadProgress, ModelManifest, Transcript, AssetManifest, AssetStatus } from '../contracts';

/** ASR 실행 단위. 입력은 16 kHz mono PCM. */
export interface AsrContext {
  utteranceId: string;
  sessionId: string;
  /** 세션 내 발화 순번 (0부터) */
  utteranceIndex: number;
  variant: AudioVariant;
  /** 세그먼트 시간을 세션 기준으로 바꾸기 위한 발화 시작 시각 */
  utteranceStartMs: number;
}

export interface AsrProvider {
  readonly modelVersion: string;
  readonly sampleRate: 16000;
  transcribe(pcm16k: Float32Array, ctx: AsrContext): Promise<Transcript>;
}

export interface TranslationProvider {
  readonly modelVersion: string;
  supports(target: LangCode): boolean;
  /** text 는 placeholder([1], [2] …)가 들어간 한국어 */
  translate(text: string, target: LangCode): Promise<string>;
}

export interface AssetState {
  model: ModelManifest;
  status: AssetStatus;
  selfTest: 'pass' | 'fail' | 'not_run';
}

/** 모델·자원 설치/검사 담당 (AssetManager). 엔진은 이 결과로 준비 상태를 판단한다. */
export interface AssetLoader {
  load(manifest: AssetManifest, onProgress?: (p: LoadProgress) => void): Promise<void>;
  states(): AssetState[];
  asr(): AsrProvider | null;
  translator(): TranslationProvider | null;
}
