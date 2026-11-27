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
  /** 받아쓰기 힌트: 발화 시점 작업 기준의 선박 이름 등. 들린 경우에만 쓰도록 지시한다 (지원하는 ASR 만 사용) */
  vocabulary?: string[];
  /** 파일 분석이면 파일명 (시연 고정 데이터가 파일별 대본을 고를 때 사용) */
  sessionFile?: string;
}

export interface AsrProvider {
  readonly modelVersion: string;
  readonly sampleRate: 16000;
  transcribe(pcm16k: Float32Array, ctx: AsrContext): Promise<Transcript>;
}

export interface TranslationProvider {
  readonly modelVersion: string;
  /**
   * placeholder(기본): [1] 자리표시를 넣은 문장을 번역하고 복원·검증한다.
   * reference: 원문을 절 단위로 그대로 번역한다 — 결과는 "참고 번역". 작은 MT 모델은 자리표시를 버리므로 이 방식을 쓴다.
   */
  readonly mode?: 'placeholder' | 'reference';
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
