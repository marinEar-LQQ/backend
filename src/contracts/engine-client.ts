import type {
  AnalysisResult,
  AssetManifest,
  AudioFrame,
  AudioVariant,
  LangCode,
  ModelRole,
  ReviewCommand,
  ReviewEvent,
  ReviewState,
  Session,
  SessionInputInfo,
  SessionSource,
  Task,
  TaskDraft,
  TaskNote,
  TaskVersion,
  Translation,
  Utterance,
  CatalogManifest,
} from './domain';
import type { EngineEventListener } from './events';

// ───────────────────────── 준비 상태 ─────────────────────────

export type AssetStatus = 'missing' | 'downloading' | 'verifying' | 'ready' | 'integrity_failed' | 'error';
export type LangAvailability = 'source' | 'ready' | 'not_installed' | 'unsupported';

export interface Readiness {
  engine: 'loading' | 'ready' | 'processing' | 'degraded' | 'error';
  queueDepth: number;
  models: Array<{ modelId: string; role: ModelRole; status: AssetStatus; selfTest: 'pass' | 'fail' | 'not_run' }>;
  catalog: { catalogVersion: string; kind: CatalogManifest['kind'] } | null;
  languages: Record<LangCode, LangAvailability>;
  storage: { usageBytes: number | null; quotaBytes: number | null; persisted: boolean | null };
  /** 앱 shell·모델·카탈로그·선택 언어 자원 + 자체 검사 통과 시에만 true. PWA 설치 여부와 별개. */
  offlineReady: boolean;
  /** 분석을 시작할 수 있는지 (false 면 openSession 이 MODEL_NOT_READY) */
  canAnalyze: boolean;
  /** 모델 없이 시연 고정 데이터로만 동작하는 모드 */
  fixtureMode: boolean;
}

export interface LoadProgress {
  modelId: string;
  loadedBytes: number;
  totalBytes: number | null;
  status: AssetStatus;
}

// ───────────────────────── 응답 타입 ─────────────────────────

export interface SaveTaskResult {
  task: Task;
  version: TaskVersion;
}

export interface AudioClip {
  status: 'available' | 'deleted' | 'missing';
  variant: AudioVariant;
  /** 요청 범위를 발화 범위로 자른 실제 구간 (세션 기준 ms) */
  startMs: number;
  endMs: number;
  mediaType: string;
  blob: Blob | null;
}

export interface UtteranceLogEntry {
  utterance: Utterance;
  /** revision 오름차순 전체 이력 */
  results: AnalysisResult[];
  translations: Translation[];
  reviewEvents: ReviewEvent[];
  reviewState: ReviewState;
}

export interface TaskLog {
  task: Task;
  versions: TaskVersion[];
  sessions: Session[];
  utterances: UtteranceLogEntry[];
  notes: TaskNote[];
  /** 실제 저장 기록 기준 집계 */
  counts: {
    utterances: number;
    differences: number;
    ambiguous: number;
    reviewed: number;
    dismissed: number;
    applied: number;
    taskChanges: number;
  };
}

export type ExportFormat = 'json' | 'txt';

export interface ExportedFile {
  filename: string;
  mimeType: string;
  /** 음성 바이너리는 포함하지 않는다 */
  content: string;
  includesAudio: false;
}

// ───────────────────────── EngineClient ─────────────────────────

/**
 * 프론트와 엔진의 공통 인터페이스 (세 문서 공통 이름).
 * 구현: WorkerEngineClient(기본) / MockEngineClient(화면 검증) / 선택적 PC adapter.
 */
export interface EngineClient {
  loadAssets(manifest: AssetManifest, onProgress?: (p: LoadProgress) => void): Promise<Readiness>;
  checkReadiness(): Promise<Readiness>;

  /** expectedVersion 이 현재 activeVersion 과 다르면 VERSION_CONFLICT */
  saveTask(draft: TaskDraft, expectedVersion?: number): Promise<SaveTaskResult>;

  openSession(taskId: string, source: SessionSource, inputInfo?: SessionInputInfo): Promise<Session>;
  /** pcm 버퍼는 transfer 된다 (호출 후 원본 사용 금지) */
  appendAudio(sessionId: string, frame: AudioFrame): Promise<void>;
  closeSession(sessionId: string): Promise<Session>;

  requestTranslation(utteranceId: string, revision: number, lang: LangCode): Promise<Translation>;
  getAudioClip(utteranceId: string, variant: AudioVariant, startMs?: number, endMs?: number): Promise<AudioClip>;

  reviewUtterance(command: ReviewCommand): Promise<ReviewEvent>;

  getTaskLog(taskId: string): Promise<TaskLog>;
  exportTaskLog(taskId: string, format: ExportFormat): Promise<ExportedFile>;

  /**
   * [확장 · 프론트 협의 필요] 일지 직접 메모. 문서 저장소 표(reviewEvents/notes)에는 있으나
   * EngineClient 목록에는 없어 추가함.
   */
  saveNote(taskId: string, text: string, noteId?: string): Promise<TaskNote>;
  listTasks(): Promise<Task[]>;

  subscribe(listener: EngineEventListener): () => void;
}
