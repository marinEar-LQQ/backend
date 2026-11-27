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
