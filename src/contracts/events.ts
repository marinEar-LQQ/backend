import type {
  AnalysisResult,
  GapEvent,
  ReviewEvent,
  ReviewState,
  SCHEMA_VERSION,
  Task,
  TaskVersion,
  Translation,
  Utterance,
} from './domain';
import type { EngineErrorPayload } from './errors';

/** 이벤트 종류는 이 8개로 고정 (프론트 03장) */
export type EngineEventType =
  | 'input.status'
  | 'analysis.progress'
  | 'transcript.partial'
  | 'analysis.final'
  | 'translation.updated'
  | 'review.updated'
  | 'task.updated'
  | 'engine.error';

export type InputStatus = 'receiving' | 'gap' | 'disconnected' | 'closed';

export type AnalysisStage =
  | 'queued'
  | 'segmenting'
  | 'enhancing'
  | 'asr_enhanced'
  | 'asr_raw'
  | 'extracting'
  | 'comparing'
  | 'failed';

export interface EventPayloads {
  'input.status': { status: InputStatus; gap?: GapEvent; queueDepth: number };
  /** 첫 progress(queued) 에는 utterance 가 함께 온다 */
  'analysis.progress': { stage: AnalysisStage; queueDepth: number; utterance?: Utterance };
  /** UI 용 잠정 자막. 검토·기준 변경에 쓰지 않는다. */
  'transcript.partial': { variant: 'raw' | 'enhanced'; text: string };
  /** 새 revision 마다 발행. raw 교차 검사가 끝나면 revision 이 올라간 final 이 다시 온다. */
  'analysis.final': { result: AnalysisResult };
  'translation.updated': { translation: Translation };
  /** 저장 성공 후에만 발행 */
  'review.updated': { event: ReviewEvent; reviewState: ReviewState };
  /** 저장 성공 후에만 발행 */
  'task.updated': { task: Task; version: TaskVersion };
  'engine.error': EngineErrorPayload;
}

export interface EngineEvent<T extends EngineEventType = EngineEventType> {
  schemaVersion: typeof SCHEMA_VERSION;
  eventId: string;
  requestId?: string;
  sessionId?: string;
  utteranceId?: string;
  /** 세션별 이벤트 순서. revision 을 대체하지 않는다. 세션 밖 이벤트는 엔진 전역 순서. */
  seq: number;
  revision?: number;
  type: T;
  payload: EventPayloads[T];
}

export type AnyEngineEvent = { [K in EngineEventType]: EngineEvent<K> }[EngineEventType];

export type EngineEventListener = (event: AnyEngineEvent) => void;
