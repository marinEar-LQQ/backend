import type { AnyEngineEvent, EngineErrorPayload, LoadProgress } from '../contracts';

/** 메인 → Worker: Command {requestId, type, payload} (백엔드 05장) */
export interface WorkerCommand {
  kind: 'command';
  requestId: string;
  type: string; // EngineClient 메서드 이름
  payload: unknown[];
}

export interface WorkerInit {
  kind: 'init';
  options: WorkerEngineOptions;
}

export interface WorkerEngineOptions {
  /**
   * online: 중계 서버(proxyUrl)를 통한 클라우드 전사·번역 — 모델 다운로드 없음, 음성이 외부로 전송됨
   * offline(기본): 기기 안 모델 (whisper-small + Opus-MT)
   */
  mode?: 'online' | 'offline';
  /** online 모드의 중계 서버 주소. 기본 http://localhost:8787 */
  proxyUrl?: string;
  dbName?: string;
  allowRemote?: boolean;
  device?: 'webgpu' | 'wasm';
  localModelPath?: string;
  skipTranslation?: boolean;
  /** true 면 모델 대신 시연 고정 데이터로 동작 (origin=fixture) */
  fixtureMode?: boolean;
}

export type WorkerReply =
  | { kind: 'result'; requestId: string; ok: true; value: unknown }
  | { kind: 'result'; requestId: string; ok: false; error: EngineErrorPayload }
  | { kind: 'event'; event: AnyEngineEvent }
  | { kind: 'progress'; requestId: string; progress: LoadProgress }
  | { kind: 'ready' };
