/** 오류 코드 (백엔드 05장 표). 오류가 나도 원문·원음 의미는 보존한다. */
export type ErrorCode =
  | 'MODEL_NOT_READY' // 분석 시작 차단, 오프라인 준비 미완료
  | 'MODEL_INTEGRITY' // 해시·버전 불일치
  | 'INPUT_DISCONNECTED' // 수신 중단
  | 'AUDIO_GAP' // seq 누락 구간
  | 'QUEUE_OVERFLOW' // 처리 큐 초과. 원음 유지, 재처리 가능
  | 'INFERENCE_FAILED' // 모델 추론 실패. 원음 유지, 재처리 가능
  | 'VERSION_CONFLICT' // expectedTaskVersion 불일치
  | 'RESULT_STALE' // expectedResultRevision 이 최신이 아님
  | 'STORAGE_FULL' // 저장 실패. 완료 이벤트 발행 안 함
  | 'TRANSLATION_UNAVAILABLE' // 언어 자원 없음. 원문 유지
  | 'VALIDATION_FAILED' // 입력 검증 실패 (장소 유효성 등)
  | 'NOT_FOUND'
  | 'CONFIRMATION_REQUIRED' // confirmedByUser=false 로 apply
  | 'UNCERTAIN_VALUE' // 미확정 값·pending 결과의 반영 시도
  | 'SESSION_CLOSED'
  | 'INTERNAL';

export interface EngineErrorPayload {
  code: ErrorCode;
  message: string;
  /** 사용자가 재시도·재처리할 수 있는지 */
  recoverable: boolean;
  details?: Record<string, unknown>;
}

export class EngineError extends Error {
  readonly code: ErrorCode;
  readonly recoverable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, recoverable = true, details?: Record<string, unknown>) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.recoverable = recoverable;
    if (details) this.details = details;
  }

  toPayload(): EngineErrorPayload {
    return {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      ...(this.details ? { details: this.details } : {}),
    };
  }

  static from(payload: EngineErrorPayload): EngineError {
    return new EngineError(payload.code, payload.message, payload.recoverable, payload.details);
  }
}

export function isEngineError(e: unknown): e is EngineError {
  return e instanceof EngineError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'EngineError');
}
