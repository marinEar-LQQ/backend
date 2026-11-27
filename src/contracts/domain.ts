/**
 * 공통 데이터 모델 (백엔드 기술설명서 04장, 통합 04장)
 * 세 문서 v1.0 계약. 바꿀 때는 프론트와 함께 변경한다.
 */

export const SCHEMA_VERSION = 1 as const;

/** 공통 언어 코드. 기존 시안의 tl 은 fil 로 마이그레이션한다. */
export type LangCode = 'ko' | 'my' | 'id' | 'en' | 'fil' | 'vi';
export const LANG_CODES: readonly LangCode[] = ['ko', 'my', 'id', 'en', 'fil', 'vi'];

/** ISO 8601 문자열 (사용자 이벤트 시각) */
export type IsoTime = string;

// ───────────────────────── 작업 기준 ─────────────────────────

/** 사용자가 입력하는 작업 초안. 검증 후 불변 TaskVersion 으로 저장된다. */
export interface TaskDraft {
  taskId?: string; // 없으면 새 작업
  ownVessel: string;
  targetVessel: string;
  terminalId: string | null;
  berthId: string | null;
  note: string;
}

/** 불변 작업 버전. 한 번 저장되면 수정하지 않고 새 version 을 만든다. */
export interface TaskVersion {
  taskId: string;
  version: number; // 1부터 단조 증가
  ownVessel: string;
  targetVessel: string;
  terminalId: string | null;
  berthId: string | null;
  note: string;
  createdAt: IsoTime;
  /** 이 버전이 어떤 검토 이벤트(apply)로 생겼는지. 직접 등록이면 null */
  sourceReviewEventId: string | null;
}

export interface Task {
  taskId: string;
  activeVersion: number;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

// ───────────────────────── 수신 ─────────────────────────

export type SessionSource = 'file' | 'live';

/** 프론트(AudioWorklet 또는 파일 디코딩)가 엔진으로 보내는 PCM 프레임 */
export interface AudioFrame {
  sessionId: string;
  seq: number; // 입력 순서. 0부터
  startMs: number; // 세션 기준 시간
  sampleRate: number;
  channels: 1;
  pcm: Float32Array;
}

export type GapReason = 'AUDIO_GAP' | 'INPUT_DISCONNECTED' | 'QUEUE_OVERFLOW';

export interface GapEvent {
  reason: GapReason;
  startMs: number;
  endMs: number | null;
  /** 누락된 seq 범위 (seq 기반 감지일 때) */
  missingSeq?: { from: number; to: number };
  at: IsoTime;
}

export interface SessionInputInfo {
  /** getUserMedia getSettings() 결과 등. 파일이면 파일명·길이 */
  deviceLabel?: string;
  fileName?: string;
  sampleRate?: number;
  /** 브라우저 자동 처리 실제 적용값 (요청: 모두 false) */
  appliedSettings?: {
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
    echoCancellation?: boolean;
  };
  /** 시연 고정 데이터 모드면 true — 화면에서 별도 배지로 구분해야 한다 */
  fixtureMode?: boolean;
}

export interface Session {
  sessionId: string;
  taskId: string;
  /** 세션을 열 때의 작업 버전 (참고용. 비교 기준은 발화별 taskVersion) */
  taskVersionAtOpen: number;
  source: SessionSource;
  startedAt: IsoTime;
  endedAt: IsoTime | null;
  inputInfo: SessionInputInfo;
  gapEvents: GapEvent[];
}

// ───────────────────────── 발화와 음성 ─────────────────────────

export type AudioVariant = 'raw' | 'enhanced';

export interface AudioRef {
  variant: AudioVariant;
  blobId: string;
  sampleRate: number;
  mediaType: string; // 예: audio/wav
  sha256: string | null;
  status: 'available' | 'deleted';
}

export interface Utterance {
  utteranceId: string;
  sessionId: string;
  taskId: string;
  /** 발화 시작 시점의 작업 버전 스냅샷. 비교는 항상 이 버전과 한다. */
  taskVersion: number;
  startMs: number;
  endMs: number;
  capturedAt: IsoTime;
  audioRefs: AudioRef[];
  /** 무음·포화·누락 등 입력 품질 근거 */
  audioFlags: AudioFlag[];
}

export type AudioFlag = 'SILENCE' | 'CLIPPING' | 'AUDIO_GAP' | 'TRUNCATED';

// ───────────────────────── 분석 결과 ─────────────────────────

export interface TranscriptSegment {
  segmentId: string;
  text: string;
  startMs: number; // 세션 기준
  endMs: number;
  /** 모델이 제공하지 않으면 null. 임의로 만들지 않는다. */
  confidence: number | null;
}

export interface Transcript {
  text: string;
  segments: TranscriptSegment[];
  modelVersion: string | null;
  /** 단어 단위 시간 정렬이 검증되었는지. false 면 전체 발화를 재생 범위로 쓴다. */
  wordAligned: boolean;
}

export type EntityField =
  | 'vessel'
  | 'terminal'
  | 'berth'
  | 'time'
  | 'distance'
  | 'identifier'
  | 'changeIntent'
  /** 속력 (예: 8kn) */
  | 'speed'
  /** 침로 (예: 320°) */
  | 'course'
  /** 관제 지시어 코드 (InstructionCode) */
  | 'instruction'
  /** 장소 (카탈로그 places: 오륙도, 팔미도 …) */
  | 'place';

export type TranscriptSource = AudioVariant;

/** 추출 후보 하나 = 값 + 근거 */
export interface EntityCandidate {
  field: EntityField;
  /** 정규화 값 (예: 터미널은 catalog terminalId, 선박은 정규화된 이름) */
  value: string;
  /** 원문 표현 그대로 */
  surface: string;
  source: TranscriptSource;
  /** 원문 text 안의 문자 위치 */
  span: { start: number; end: number };
  segmentId: string | null;
  /** confusable = 실측에서 자주 틀린 표기로 찾은 후보. 절대 확정하지 않는다 */
  method: 'catalog-alias' | 'confusable' | 'pattern' | 'vessel-name' | 'keyword';
  /** 정정·부정 문맥 ("HPNT 말고 PNIT" 의 HPNT) 이면 true */
  negated: boolean;
}

/** 확정값. 불명확하면 null — 후보는 uncertainties 에 남긴다. */
export interface ResolvedEntities {
  vessel: string | null;
  terminalId: string | null;
  berthId: string | null;
  time: string | null;
  distance: string | null;
  identifier: string | null;
  changeIntent: boolean | null;
  speed: string | null;
  course: string | null;
  /** 들린 지시어 (순서대로, 중복 제거) */
  instructions: InstructionCode[];
}

/** 관제 지시어 (IMO 해사 표준 문구 기반 번역에 쓰는 코드) */
export type InstructionCode =
  | 'REDUCE_SPEED'
  | 'PASS_PORT_TO_PORT'
  | 'PASS_STBD_TO_STBD'
  | 'KEEP_CLEAR'
  | 'STAND_BY'
  | 'BERTH'
  | 'PROCEED'
  | 'ALTER_COURSE_STBD'
  | 'ALTER_COURSE_PORT'
  | 'CORRECTION'
  /** 엔진 문제 보고 */
  | 'ENGINE_TROUBLE'
  /** 예인(끌어 줄 배) 요청 */
  | 'TOW_REQUESTED';

/** 등록 작업이 없으면 unknown + NO_TASK (비교 불가) */
export type ComparisonKind = 'match' | 'difference' | 'ambiguous' | 'unrelated' | 'unknown';

export type ReasonCode =
  | 'ASR_DISAGREEMENT'
  | 'TERMINAL_MISSING'
  | 'BERTH_MISSING'
  | 'VESSEL_MISSING'
  | 'VESSEL_AMBIGUOUS'
  | 'MULTIPLE_CANDIDATES'
  | 'CORRECTION_UNCLEAR'
  | 'CATALOG_UNKNOWN'
  | 'BERTH_NOT_IN_TERMINAL'
  | 'NUMBER_TYPE_UNCLEAR'
  | 'OTHER_VESSEL'
  | 'LOCATION_DIFFERS'
  | 'LOCATION_MATCHES'
  | 'NO_TASK'
  | 'CROSS_CHECK_PENDING'
  | 'AUDIO_QUALITY'
  /** 오인식 후보 사전으로만 찾은 값 (예: '펜트' → HPNT?) */
  | 'ASR_CONFUSABLE';

export interface FieldDiff {
  field: 'terminalId' | 'berthId';
  taskValue: string | null;
  heardValue: string | null;
}

export interface Comparison {
  kind: ComparisonKind;
  reasonCodes: ReasonCode[];
  /** 비교에 쓴 작업 버전 (발화 시점 스냅샷) */
  taskId: string | null;
  taskVersion: number | null;
  diffs: FieldDiff[];
}

export interface Uncertainty {
  field: 'vessel' | 'terminalId' | 'berthId' | 'time' | 'number';
  alternatives: string[];
  reason: ReasonCode;
}

export type CrossCheck = 'pending' | 'complete' | 'unavailable';

/** 원음/완화음 자막 단어 단위 차이. changed/added/removed 는 화면에서 "확인 필요"로 강조 */
export interface WordDiff {
  op: 'same' | 'changed' | 'added' | 'removed';
  raw: string | null;
  enhanced: string | null;
}

export interface AnalysisResult {
  schemaVersion: typeof SCHEMA_VERSION;
  utteranceId: string;
  sessionId: string;
  taskId: string | null;
  taskVersion: number | null;
  /** 동일 발화 내 단조 증가 정수 */
  revision: number;
  status: 'partial' | 'final';
  timing: { startMs: number; endMs: number };
  rawTranscript: Transcript | null;
  enhancedTranscript: Transcript | null;
  candidates: EntityCandidate[];
  entities: ResolvedEntities;
  comparison: Comparison;
  uncertainties: Uncertainty[];
  crossCheck: CrossCheck;
  /** 원음·완화음 둘 다 인식됐을 때만 채워진다 (crossCheck=complete). 순서대로 이어 붙이면 자막 */
  transcriptDiff: WordDiff[] | null;
  audioFlags: AudioFlag[];
  modelVersions: { asr: string | null; enhancer: string | null };
  catalogVersion: string;
  /** model = 실제 모델 결과, fixture = 시연 고정 데이터. 화면에서 반드시 구분 */
  origin: 'model' | 'fixture';
  createdAt: IsoTime;
}

// ───────────────────────── 번역 ─────────────────────────

export type TranslationStatus = 'pending' | 'ready' | 'needs_check' | 'failed' | 'unavailable';

export interface ProtectedToken {
  placeholder: string; // 예: ⟦T0⟧
  value: string; // 원문 값 (예: PNIT, T3, 14:30)
  field: EntityField | 'uncertain';
}

export interface Translation {
  utteranceId: string;
  /** 번역 대상 분석 revision. 다른 revision 화면에 덮어쓰지 않는다. */
  sourceRevision: number;
  targetLang: LangCode;
  status: TranslationStatus;
  text: string | null;
  protectedTokens: ProtectedToken[];
  modelVersion: string | null;
  /** needs_check / failed 사유 */
  issues: string[];
  createdAt: IsoTime;
  /** 번역 모델 없이 추출값으로 만든 정형 요약 (정확). 지원하지 않는 언어면 null */
  summary: TranslationSummary | null;
  /** true 면 text 는 참고용 기계번역 — 화면에 "참고 번역" 표시 */
  reference: boolean;
}

export interface SummaryLine {
  field: 'vessel' | 'terminal' | 'berth' | 'place' | 'time' | 'speed' | 'course' | 'distance' | 'identifier' | 'instruction';
  label: string;
  value: string;
  /** 불확실한 값이면 true — 확정값처럼 표시하지 말 것 */
  uncertain: boolean;
}

export interface TranslationSummary {
  lang: LangCode;
  lines: SummaryLine[];
  /** 한 줄 요약 (lines 를 이어 붙인 것) */
  oneLine: string;
}

// ───────────────────────── 사용자 확인 ─────────────────────────

export type ReviewAction = 'review' | 'dismiss' | 'apply';
export type ReviewState = 'unreviewed' | 'reviewed' | 'dismissed' | 'applied';

/** apply 시 사용자가 명시적으로 선택한 값 */
export interface TaskPatch {
  terminalId?: string | null;
  berthId?: string | null;
  targetVessel?: string;
}

export interface ReviewCommand {
  /** 멱등 키. 같은 requestId 반복 요청은 같은 결과를 돌려준다. */
  requestId: string;
  utteranceId: string;
  action: ReviewAction;
  expectedResultRevision: number;
  expectedTaskVersion: number;
  confirmedByUser: boolean;
  patch?: TaskPatch;
  note?: string;
}

export interface ReviewEvent {
  eventId: string;
  requestId: string;
  utteranceId: string;
  taskId: string;
  resultRevision: number;
  action: ReviewAction;
  at: IsoTime;
  confirmedByUser: boolean;
  taskVersionBefore: number;
  taskVersionAfter: number;
  patch: TaskPatch | null;
  note: string | null;
}

export interface TaskNote {
  noteId: string;
  taskId: string;
  text: string;
  at: IsoTime;
  deleted: boolean;
}

// ───────────────────────── 자원 manifest ─────────────────────────

export type ModelRole = 'asr' | 'enhancer' | 'vad' | 'translation' | 'tokenizer';

export interface ModelManifest {
  modelId: string;
  version: string;
  sha256: string | null;
  bytes: number | null;
  role: ModelRole;
  inputSpec: { sampleRate?: number; channels?: number; maxSeconds?: number } | null;
  languages: LangCode[];
  license: string;
  runtimeVersion: string;
  /** translation 이면 지원 언어쌍 */
  langPairs?: Array<[LangCode, LangCode]>;
}

export interface BerthEntry {
  berthId: string;
  label: string;
  aliases: string[];
}

export interface TerminalEntry {
  terminalId: string;
  officialName: string;
  displayName: string;
  aliases: string[];
  /** 실측 오인식 표기. 후보로만 연결하고 확정하지 않는다 (예: HPNT ← 펜트) */
  confusables?: string[];
  port: string;
  berths: BerthEntry[];
  sourceUrl: string | null;
  verifiedAt: string | null;
}

export interface PlaceEntry {
  placeId: string;
  label: string;
  aliases: string[];
}

export interface CatalogManifest {
  catalogVersion: string;
  /** 터미널이 아닌 장소 (섬·수로·항만 구역). 요약 카드의 "위치"에 쓴다 */
  places?: PlaceEntry[];
  /** demo = 시연 fixture. 실제 운영 카탈로그는 공식 자료로 확정 */
  kind: 'demo' | 'verified';
  sourceRefs: string[];
  verifiedAt: string | null;
  terminals: TerminalEntry[];
}

export interface AssetManifest {
  manifestVersion: string;
  models: ModelManifest[];
  catalog: CatalogManifest;
}
