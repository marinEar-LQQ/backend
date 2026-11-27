import {
  EngineError,
  LANG_CODES,
  SCHEMA_VERSION,
  validateReviewCommand,
  validateTaskDraft,
  type AnalysisResult,
  type AnalysisStage,
  type AnyEngineEvent,
  type AssetManifest,
  type AudioClip,
  type AudioFrame,
  type AudioRef,
  type AudioVariant,
  type CatalogManifest,
  type CrossCheck,
  type EngineClient,
  type EngineEvent,
  type EngineEventListener,
  type EngineEventType,
  type EventPayloads,
  type ExportFormat,
  type ExportedFile,
  type LangAvailability,
  type LangCode,
  type LoadProgress,
  type Readiness,
  type ReasonCode,
  type ReviewCommand,
  type ReviewEvent,
  type ReviewState,
  type SaveTaskResult,
  type Session,
  type SessionInputInfo,
  type SessionSource,
  type Task,
  type TaskDraft,
  type TaskLog,
  type TaskNote,
  type TaskVersion,
  type Transcript,
  type Translation,
  type Utterance,
  type UtteranceLogEntry,
} from '../contracts';
import type { TaskLogRepository } from '../repositories/task-log-repository';
import { decodeWav, encodeWav, resample, sha256Hex } from './audio/dsp';
import { ENHANCER_VERSION, enhanceSpeech } from './audio/enhance';
import { Segmenter, type SegmentedUtterance, type SegmenterOptions } from './audio/segmenter';
import { exportLog } from './export';
import type { AsrProvider, AssetLoader, TranslationProvider } from './providers';
import { analyzeUtterance } from './rules/compare';
import { buildProtectedSource, missingValues, restoreTokens, splitClauses } from './translate/protect';
import { buildSummary } from './translate/summary';
import { diffTranscripts } from './rules/diff';
import { collapseRepeats } from './models/transformers-providers';

export interface EngineCoreDeps {
  repo: TaskLogRepository;
  catalog: CatalogManifest;
  /** 자원 로더가 있으면 asr/translator 를 여기서 가져온다 */
  assets?: AssetLoader;
  asr?: AsrProvider | null;
  translator?: TranslationProvider | null;
  /** 시연 고정 데이터 모드 (결과 origin=fixture, 화면에서 배지로 구분) */
  fixtureMode?: boolean;
  /** 준비 상태에 표시할 실행 방식 (기본 offline) */
  mode?: 'online' | 'offline';
  segmenter?: Partial<SegmenterOptions>;
  maxQueue?: number;
  now?: () => string;
  newId?: (prefix: string) => string;
}

interface SessionRuntime {
  session: Session;
  segmenter: Segmenter;
  utteranceIndex: number;
  /** 세션 시간축 위의 작업 버전 변경 지점 (발화 시작 시점 스냅샷용) */
  versionMarks: Array<{ atMs: number; version: number }>;
  lastFrameMs: number;
  open: boolean;
}

interface Job {
  utterance: Utterance;
  sessionFile?: string;
  rawPcm: Float32Array;
  sampleRate: number;
  index: number;
}

const ASR_RATE = 16000;

function defaultId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${uuid}`;
}

/**
 * EngineCore — EngineClient 계약의 실제 구현. Worker 안(WorkerEngineClient)이나
 * 메인 스레드(MockEngineClient)에서 같은 코드로 동작한다.
 *
 * 처리 순서 (백엔드 02장): 프레임 수신 → 순서/누락 검사 → 발화 분리 → 원음 저장
 *  → 16k 리샘플 → 잡음 완화 → enhanced ASR → (rev1, crossCheck=pending)
 *  → raw ASR → 교차 검사 → (rev2, crossCheck=complete)
 */
export class EngineCore implements EngineClient {
  private readonly listeners = new Set<EngineEventListener>();
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly seqBySession = new Map<string, number>();
  private globalSeq = 0;
  private readonly queue: Job[] = [];
  private processing = false;
  private idleWaiters: Array<() => void> = [];
  private readonly activeVersionCache = new Map<string, number>();
  private engineError: string | null = null;
  private readonly now: () => string;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly deps: EngineCoreDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? defaultId;
  }

  // ───────────────────────── 이벤트 ─────────────────────────

  subscribe(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit<T extends EngineEventType>(
    type: T,
    payload: EventPayloads[T],
    meta: { sessionId?: string; utteranceId?: string; requestId?: string; revision?: number } = {},
  ): void {
    let seq: number;
    if (meta.sessionId) {
      seq = (this.seqBySession.get(meta.sessionId) ?? 0) + 1;
      this.seqBySession.set(meta.sessionId, seq);
    } else {
      seq = ++this.globalSeq;
    }
    const event: EngineEvent<T> = {
      schemaVersion: SCHEMA_VERSION,
      eventId: this.newId('evt'),
      seq,
      type,
      payload,
      ...(meta.requestId ? { requestId: meta.requestId } : {}),
      ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
      ...(meta.utteranceId ? { utteranceId: meta.utteranceId } : {}),
      ...(meta.revision !== undefined ? { revision: meta.revision } : {}),
    };
    for (const l of this.listeners) {
      try {
        l(event as unknown as AnyEngineEvent);
      } catch {
        /* 리스너 오류가 엔진을 멈추지 않게 */
      }
    }
  }

  private emitError(e: unknown, meta: { sessionId?: string; utteranceId?: string; requestId?: string } = {}): EngineError {
    const err = e instanceof EngineError ? e : new EngineError('INTERNAL', String((e as Error)?.message ?? e), true);
    this.emit('engine.error', err.toPayload(), meta);
    return err;
  }

  // ───────────────────────── 자원·준비 ─────────────────────────

  private get asr(): AsrProvider | null {
    return this.deps.assets?.asr() ?? this.deps.asr ?? null;
  }

  private get translator(): TranslationProvider | null {
    return this.deps.assets?.translator() ?? this.deps.translator ?? null;
  }

  async loadAssets(manifest: AssetManifest, onProgress?: (p: LoadProgress) => void): Promise<Readiness> {
    if (this.deps.assets) {
      try {
        await this.deps.assets.load(manifest, onProgress);
        this.engineError = null;
      } catch (e) {
        this.engineError = String((e as Error)?.message ?? e);
        throw this.emitError(e);
      }
    }
    return this.checkReadiness();
  }

  async checkReadiness(): Promise<Readiness> {
    const states = this.deps.assets?.states() ?? [];
    const asr = this.asr;
    const tr = this.translator;
    const languages = Object.fromEntries(
      LANG_CODES.map((l): [LangCode, LangAvailability] => [l, l === 'ko' ? 'source' : tr?.supports(l) ? 'ready' : 'not_installed']),
    ) as Record<LangCode, LangAvailability>;

    let storage: Readiness['storage'] = { usageBytes: null, quotaBytes: null, persisted: null };
    try {
      const sm = (globalThis.navigator as Navigator | undefined)?.storage;
      if (sm?.estimate) {
        const est = await sm.estimate();
        storage = { usageBytes: est.usage ?? null, quotaBytes: est.quota ?? null, persisted: sm.persisted ? await sm.persisted() : null };
      }
    } catch {
      /* 저장소 정보 없음 */
    }

    const modelsOk = states.length === 0 ? asr !== null : states.filter((s) => s.model.role === 'asr').every((s) => s.status === 'ready' && s.selfTest !== 'fail');
    const canAnalyze = asr !== null && modelsOk;
    return {
      engine: this.engineError ? 'error' : this.processing ? 'processing' : canAnalyze ? 'ready' : 'degraded',
      queueDepth: this.queue.length,
      models: states.map((s) => ({ modelId: s.model.modelId, role: s.model.role, status: s.status, selfTest: s.selfTest })),
      catalog: { catalogVersion: this.deps.catalog.catalogVersion, kind: this.deps.catalog.kind },
      languages,
      storage,
      offlineReady: canAnalyze && states.length > 0 && states.every((s) => s.status === 'ready' && s.selfTest === 'pass'),
      canAnalyze,
      fixtureMode: this.deps.fixtureMode ?? false,
      mode: this.deps.fixtureMode ? 'fixture' : (this.deps.mode ?? 'offline'),
    };
  }

  // ───────────────────────── 작업 ─────────────────────────

  async listTasks(): Promise<Task[]> {
    return this.deps.repo.listTasks();
  }

  async saveTask(draft: TaskDraft, expectedVersion?: number): Promise<SaveTaskResult> {
    const issues = validateTaskDraft(draft, this.deps.catalog);
    if (issues.length) throw new EngineError('VALIDATION_FAILED', issues.map((i) => i.message).join(' '), true, { issues });
    const taskId = draft.taskId ?? this.newId('task');
    const res = await this.deps.repo.saveTaskVersion(taskId, draft, expectedVersion, this.now());
    this.markVersion(taskId, res.version.version);
    this.emit('task.updated', res);
    return res;
  }

  private markVersion(taskId: string, version: number): void {
    this.activeVersionCache.set(taskId, version);
    for (const rt of this.sessions.values()) {
      if (rt.open && rt.session.taskId === taskId) rt.versionMarks.push({ atMs: rt.lastFrameMs, version });
    }
  }

  async saveNote(taskId: string, text: string, noteId?: string): Promise<TaskNote> {
    if (!(await this.deps.repo.getTask(taskId))) throw new EngineError('NOT_FOUND', '작업이 없습니다.', false);
    const note: TaskNote = { noteId: noteId ?? this.newId('note'), taskId, text, at: this.now(), deleted: text.trim() === '' };
    await this.deps.repo.putNote(note);
    return note;
  }

  // ───────────────────────── 수신 세션 ─────────────────────────

  async openSession(taskId: string, source: SessionSource, inputInfo: SessionInputInfo = {}): Promise<Session> {
    const task = await this.deps.repo.getTask(taskId);
    if (!task) throw new EngineError('NOT_FOUND', '작업을 먼저 등록하세요.', false, { taskId });
    if (!this.asr) throw this.emitError(new EngineError('MODEL_NOT_READY', '음성인식 모델이 준비되지 않아 분석을 시작할 수 없습니다.', true));
    const session: Session = {
      sessionId: this.newId('ses'),
      taskId,
      taskVersionAtOpen: task.activeVersion,
      source,
      startedAt: this.now(),
      endedAt: null,
      inputInfo: { ...inputInfo, ...(this.deps.fixtureMode ? { fixtureMode: true } : {}) },
      gapEvents: [],
    };
    await this.deps.repo.putSession(session);
    this.activeVersionCache.set(taskId, task.activeVersion);
    this.sessions.set(session.sessionId, {
      session,
      segmenter: new Segmenter(this.deps.segmenter, this.now),
      utteranceIndex: 0,
      versionMarks: [{ atMs: 0, version: task.activeVersion }],
      lastFrameMs: 0,
      open: true,
    });
    this.emit('input.status', { status: 'receiving', queueDepth: this.queue.length }, { sessionId: session.sessionId });
    return session;
  }

  async appendAudio(sessionId: string, frame: AudioFrame): Promise<void> {
    const rt = this.sessions.get(sessionId);
    if (!rt || !rt.open) throw new EngineError('SESSION_CLOSED', '수신 세션이 열려 있지 않습니다.', false, { sessionId });
    rt.lastFrameMs = frame.startMs;
    const { gaps, utterances } = rt.segmenter.push(frame);
    if (gaps.length) {
      rt.session.gapEvents.push(...gaps);
      await this.deps.repo.putSession(rt.session);
      for (const gap of gaps) {
        this.emit('input.status', { status: 'gap', gap, queueDepth: this.queue.length }, { sessionId });
        this.emit('engine.error', { code: 'AUDIO_GAP', message: '수신 누락 구간이 있습니다.', recoverable: true, details: { ...gap } }, { sessionId });
      }
    }
    for (const seg of utterances) await this.createUtterance(rt, seg);
  }

  async closeSession(sessionId: string): Promise<Session> {
    const rt = this.sessions.get(sessionId);
    if (!rt) {
      const stored = await this.deps.repo.getSession(sessionId);
      if (stored) return stored;
      throw new EngineError('NOT_FOUND', '세션이 없습니다.', false);
    }
    if (rt.open) {
      for (const seg of rt.segmenter.flush()) await this.createUtterance(rt, seg);
      rt.open = false;
      rt.session.endedAt = this.now();
      await this.deps.repo.putSession(rt.session);
      this.emit('input.status', { status: 'closed', queueDepth: this.queue.length }, { sessionId });
    }
    return rt.session;
  }

  /** 입력 장치가 끊겼을 때 (프론트가 호출). 수신 상태를 해제하고 누락으로 기록한다. */
  async markDisconnected(sessionId: string): Promise<void> {
    const rt = this.sessions.get(sessionId);
    if (!rt) return;
    const gap = { reason: 'INPUT_DISCONNECTED' as const, startMs: rt.lastFrameMs, endMs: null, at: this.now() };
    rt.session.gapEvents.push(gap);
    await this.deps.repo.putSession(rt.session);
    this.emit('input.status', { status: 'disconnected', gap, queueDepth: this.queue.length }, { sessionId });
  }

  private versionAt(rt: SessionRuntime, startMs: number): number {
    let v = rt.versionMarks[0]!.version;
    for (const m of rt.versionMarks) if (m.atMs <= startMs) v = m.version;
    return v;
  }

  private async storeAudio(variant: AudioVariant, pcm: Float32Array, sampleRate: number): Promise<AudioRef> {
    const wav = encodeWav(pcm, sampleRate);
    const sha = await sha256Hex(wav);
    const blobId = this.newId(`aud-${variant}`);
    await this.deps.repo.putAudio({ blobId, blob: new Blob([wav], { type: 'audio/wav' }), mediaType: 'audio/wav', sampleRate, sha256: sha, status: 'available', createdAt: this.now() });
    return { variant, blobId, sampleRate, mediaType: 'audio/wav', sha256: sha, status: 'available' };
  }

  private async createUtterance(rt: SessionRuntime, seg: SegmentedUtterance): Promise<void> {
    const sessionId = rt.session.sessionId;
    const rawRef = await this.storeAudio('raw', seg.pcm, seg.sampleRate); // 원음은 원래 sampleRate 그대로 보존
    const utterance: Utterance = {
      utteranceId: this.newId('utt'),
      sessionId,
      taskId: rt.session.taskId,
      taskVersion: this.versionAt(rt, seg.startMs),
      startMs: seg.startMs,
      endMs: seg.endMs,
      capturedAt: this.now(),
      audioRefs: [rawRef],
      audioFlags: seg.flags,
    };
    await this.deps.repo.putUtterance(utterance);
    const index = rt.utteranceIndex++;

    const maxQueue = this.deps.maxQueue ?? 30;
    if (this.queue.length >= maxQueue) {
      // 큐 초과: 원음은 저장했고, 분석만 실패로 표시 (재처리 가능)
      this.emit('analysis.progress', { stage: 'failed', queueDepth: this.queue.length, utterance }, { sessionId, utteranceId: utterance.utteranceId });
      this.emitError(new EngineError('QUEUE_OVERFLOW', '처리 대기열이 가득 차 이 발화는 분석하지 못했습니다. 원음은 보존했습니다.', true), { sessionId, utteranceId: utterance.utteranceId });
      return;
    }
    this.queue.push({ utterance, rawPcm: seg.pcm, sampleRate: seg.sampleRate, index, ...(rt.session.inputInfo.fileName ? { sessionFile: rt.session.inputInfo.fileName } : {}) });
    this.emit('analysis.progress', { stage: 'queued', queueDepth: this.queue.length, utterance }, { sessionId, utteranceId: utterance.utteranceId });
    void this.drain();
  }

  // ───────────────────────── 분석 큐 ─────────────────────────

  /** 큐가 빌 때까지 대기 (테스트·파일 분석 완료 판정용) */
  whenIdle(): Promise<void> {
    if (!this.processing && this.queue.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        try {
          await this.process(job);
        } catch (e) {
          const ids = { sessionId: job.utterance.sessionId, utteranceId: job.utterance.utteranceId };
          this.emit('analysis.progress', { stage: 'failed', queueDepth: this.queue.length }, ids);
          const err = e instanceof EngineError ? e : new EngineError('INFERENCE_FAILED', `분석 실패: ${String((e as Error)?.message ?? e)}. 원음은 보존했습니다.`, true);
          this.emitError(err, ids);
        }
      }
    } finally {
      this.processing = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((w) => w());
    }
  }

  private progress(job: Job, stage: AnalysisStage): void {
    this.emit('analysis.progress', { stage, queueDepth: this.queue.length }, { sessionId: job.utterance.sessionId, utteranceId: job.utterance.utteranceId });
  }

  private async process(job: Job): Promise<void> {
    const asr = this.asr;
    if (!asr) throw new EngineError('MODEL_NOT_READY', '음성인식 모델이 없습니다.', true);
    const { utterance } = job;
    const ids = { sessionId: utterance.sessionId, utteranceId: utterance.utteranceId };
    const ctxBase = { utteranceId: utterance.utteranceId, sessionId: utterance.sessionId, utteranceIndex: job.index, utteranceStartMs: utterance.startMs, ...(job.sessionFile ? { sessionFile: job.sessionFile } : {}) };

    // 1) 리샘플 + 잡음 완화 (완화음은 별도 파생 파일)
    this.progress(job, 'enhancing');
    const pcm16 = resample(job.rawPcm, job.sampleRate, ASR_RATE);
    const enhanced = enhanceSpeech(pcm16, ASR_RATE);
    const enhRef = await this.storeAudio('enhanced', enhanced, ASR_RATE);
    utterance.audioRefs = [...utterance.audioRefs, enhRef];
    await this.deps.repo.putUtterance(utterance);

    const task = await this.deps.repo.getTaskVersion(utterance.taskId, utterance.taskVersion);
    // 받아쓰기 힌트: 등록된 내 배·대상 선박 이름 (실측: 선박명 오인식이 가장 많았다 — 한라호→"한라오")
    if (task) Object.assign(ctxBase, { vocabulary: [task.ownVessel, task.targetVessel].filter(Boolean) });

    // 2) enhanced ASR → rev1 (crossCheck=pending). 빠른 자막을 지원하면 rev1 은 fast 로 먼저 보여 준다
    this.progress(job, 'asr_enhanced');
    const fast = asr.supportsFast === true;
    let enhT = await asr.transcribe(enhanced, { ...ctxBase, variant: 'enhanced', ...(fast ? { quality: 'fast' as const } : {}) });
    this.emit('transcript.partial', { variant: 'enhanced', text: enhT.text }, ids);
    this.progress(job, 'comparing');
    const rev1 = this.buildResult(utterance, task, enhT, null, 'pending', 1, asr.modelVersion);
    await this.saveAndEmit(rev1);

    // 3) raw ASR → 교차 검사 → rev2. 빠른 자막 모드면 완화음도 정확한 모델로 다시 받아써 확정 (원음과 동시에)
    this.progress(job, 'asr_raw');
    let rawT: Transcript | null = null;
    let cross: CrossCheck = 'complete';
    const accurateEnh = fast
      ? asr.transcribe(enhanced, { ...ctxBase, variant: 'enhanced', quality: 'accurate' }).catch(() => null) // 실패하면 빠른 자막을 그대로 쓴다
      : Promise.resolve(null);
    try {
      rawT = await asr.transcribe(pcm16, { ...ctxBase, variant: 'raw' });
    } catch (e) {
      cross = 'unavailable'; // 교차 검사를 끄고 정상 완료로 표시하지 않는다
      this.emitError(new EngineError('INFERENCE_FAILED', `원음 인식 실패로 교차 검사를 하지 못했습니다: ${String((e as Error)?.message ?? e)}`, true), ids);
    }
    enhT = (await accurateEnh) ?? enhT;
    const rev2 = this.buildResult(utterance, task, enhT, rawT, cross, 2, asr.modelVersion);
    await this.saveAndEmit(rev2);
  }

  private buildResult(
    utterance: Utterance,
    task: TaskVersion | null,
    enhanced: Transcript | null,
    raw: Transcript | null,
    crossCheck: CrossCheck,
    revision: number,
    asrVersion: string,
  ): AnalysisResult {
    const out = analyzeUtterance({ enhanced, raw, crossCheck, task, catalog: this.deps.catalog });
    const reasons: ReasonCode[] = [...out.comparison.reasonCodes];
    if (utterance.audioFlags.length && !reasons.includes('AUDIO_QUALITY')) reasons.push('AUDIO_QUALITY');
    return {
      schemaVersion: SCHEMA_VERSION,
      utteranceId: utterance.utteranceId,
      sessionId: utterance.sessionId,
      taskId: utterance.taskId,
      taskVersion: utterance.taskVersion,
      revision,
      status: 'final',
      timing: { startMs: utterance.startMs, endMs: utterance.endMs },
      rawTranscript: raw,
      enhancedTranscript: enhanced,
      candidates: out.candidates,
      entities: out.entities,
      comparison: { ...out.comparison, reasonCodes: reasons },
      uncertainties: out.uncertainties,
      crossCheck,
      transcriptDiff: raw && enhanced && crossCheck === 'complete' ? diffTranscripts(raw.text, enhanced.text) : null,
      audioFlags: utterance.audioFlags,
      modelVersions: { asr: asrVersion, enhancer: ENHANCER_VERSION },
      catalogVersion: this.deps.catalog.catalogVersion,
      origin: this.deps.fixtureMode ? 'fixture' : 'model',
      createdAt: this.now(),
    };
  }

  private async saveAndEmit(result: AnalysisResult): Promise<void> {
    const stored = await this.deps.repo.putResult(result);
    if (stored === 'stored') {
      this.emit('analysis.final', { result }, { sessionId: result.sessionId, utteranceId: result.utteranceId, revision: result.revision });
    }
  }

  // ───────────────────────── 번역 ─────────────────────────

  async requestTranslation(utteranceId: string, revision: number, lang: LangCode): Promise<Translation> {
    const results = await this.deps.repo.listResults(utteranceId);
    const result = results.find((r) => r.revision === revision);
    if (!result) throw new EngineError('NOT_FOUND', '해당 revision 의 분석 결과가 없습니다.', false, { utteranceId, revision });

    const cached = await this.deps.repo.getTranslation(utteranceId, revision, lang);
    if (cached && cached.status !== 'failed') return cached;

    const src = buildProtectedSource(result);
    const base = { utteranceId, sourceRevision: revision, targetLang: lang, protectedTokens: src.tokens, createdAt: this.now() };
    let translation: Translation;

    const summary = buildSummary(result, lang, this.deps.catalog);
    const base2 = { ...base, summary };

    if (lang === 'ko') {
      translation = { ...base2, status: 'ready', text: src.displayText, modelVersion: null, issues: [], reference: false };
    } else {
      const tr = this.translator;
      if (!tr || !tr.supports(lang)) {
        // 문장 번역은 없어도 정형 요약(summary)은 그대로 제공된다
        translation = { ...base2, status: 'unavailable', text: null, modelVersion: tr?.modelVersion ?? null, issues: ['TRANSLATION_UNAVAILABLE'], reference: false };
      } else if (tr.mode === 'reference') {
        // 참고용 기계번역: 절 단위로 쪼개 번역 (긴 관제 문장의 뒷부분 누락 방지). 값 보존 여부만 검사하고 "참고" 표시
        try {
          const parts: string[] = [];
          for (const clause of splitClauses(src.displayText)) parts.push(await tr.translate(clause, lang));
          const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
          const text = collapseRepeats(joined).text;
          const issues = missingValues(text, src.tokens);
          translation = { ...base2, status: issues.length ? 'needs_check' : 'ready', text, modelVersion: tr.modelVersion, issues, reference: true };
        } catch (e) {
          translation = { ...base2, status: 'failed', text: null, modelVersion: tr.modelVersion, issues: [String((e as Error)?.message ?? e)], reference: true };
        }
      } else {
        try {
          const out = await tr.translate(src.protectedText, lang);
          const restored = restoreTokens(out, src.tokens);
          translation = { ...base2, status: restored.ok ? 'ready' : 'needs_check', text: restored.text, modelVersion: tr.modelVersion, issues: restored.issues, reference: false };
        } catch (e) {
          const unavailable = e instanceof EngineError && e.code === 'TRANSLATION_UNAVAILABLE';
          translation = { ...base2, status: unavailable ? 'unavailable' : 'failed', text: null, modelVersion: tr.modelVersion, issues: [String((e as Error)?.message ?? e)], reference: false };
        }
      }
    }
    await this.deps.repo.putTranslation(translation);
    this.emit('translation.updated', { translation }, { utteranceId, revision, sessionId: result.sessionId });
    return translation;
  }

  // ───────────────────────── 재생 ─────────────────────────

  async getAudioClip(utteranceId: string, variant: AudioVariant, startMs?: number, endMs?: number): Promise<AudioClip> {
    const utt = await this.deps.repo.getUtterance(utteranceId);
    if (!utt) throw new EngineError('NOT_FOUND', '발화가 없습니다.', false);
    const ref = utt.audioRefs.find((a) => a.variant === variant);
    const s = Math.max(utt.startMs, startMs ?? utt.startMs);
    const e = Math.min(utt.endMs, endMs ?? utt.endMs);
    const empty = { variant, startMs: s, endMs: e, mediaType: 'audio/wav', blob: null };
    if (!ref) return { ...empty, status: 'missing' };
    const rec = await this.deps.repo.getAudio(ref.blobId);
    if (!rec) return { ...empty, status: 'missing' };
    if (rec.status === 'deleted') return { ...empty, status: 'deleted' };
    if (s === utt.startMs && e === utt.endMs) return { ...empty, status: 'available', blob: rec.blob, mediaType: rec.mediaType };
    // 부분 구간: 발화 안에서 잘라 새 WAV 로
    const { pcm, sampleRate } = decodeWav(await rec.blob.arrayBuffer());
    const a = Math.floor(((s - utt.startMs) / 1000) * sampleRate);
    const b = Math.min(pcm.length, Math.ceil(((e - utt.startMs) / 1000) * sampleRate));
    const blob = new Blob([encodeWav(pcm.slice(a, b), sampleRate)], { type: 'audio/wav' });
    return { ...empty, status: 'available', blob };
  }

  // ───────────────────────── 확인·반영 ─────────────────────────

  async reviewUtterance(command: ReviewCommand): Promise<ReviewEvent> {
    const issues = validateReviewCommand(command);
    if (issues.length) throw new EngineError('VALIDATION_FAILED', issues.map((i) => i.message).join(' '), true, { issues });

    const prior = await this.deps.repo.findReviewByRequest(command.requestId);
    if (prior) return prior; // 멱등: 같은 요청은 같은 결과

    const utt = await this.deps.repo.getUtterance(command.utteranceId);
    if (!utt) throw new EngineError('NOT_FOUND', '발화가 없습니다.', false);
    const latest = await this.deps.repo.latestResult(command.utteranceId);
    if (!latest) throw new EngineError('NOT_FOUND', '분석 결과가 없습니다.', false);

    let nextVersion = null;
    if (command.action === 'apply') {
      if (!command.confirmedByUser) throw new EngineError('CONFIRMATION_REQUIRED', '사용자 확인 후에만 기록에 반영할 수 있습니다.', true);
      if (latest.status !== 'final' || latest.crossCheck !== 'complete') {
        throw new EngineError('UNCERTAIN_VALUE', '교차 검사가 끝나지 않은 결과는 바로 반영할 수 없습니다.', true, { crossCheck: latest.crossCheck });
      }
      const active = await this.deps.repo.getActiveVersion(utt.taskId);
      if (!active) throw new EngineError('NOT_FOUND', '작업이 없습니다.', false);
      const patch = command.patch!;
      const draft: TaskDraft = {
        taskId: active.taskId,
        ownVessel: active.ownVessel,
        targetVessel: patch.targetVessel ?? active.targetVessel,
        terminalId: patch.terminalId !== undefined ? patch.terminalId : active.terminalId,
        berthId: patch.berthId !== undefined ? patch.berthId : active.berthId,
        note: active.note,
      };
      const vIssues = validateTaskDraft(draft, this.deps.catalog);
      if (vIssues.length) throw new EngineError('VALIDATION_FAILED', vIssues.map((i) => i.message).join(' '), true, { issues: vIssues });
      nextVersion = { taskId: active.taskId, ownVessel: draft.ownVessel, targetVessel: draft.targetVessel, terminalId: draft.terminalId, berthId: draft.berthId, note: draft.note };
    }

    const res = await this.deps.repo.applyReview({ command, eventId: this.newId('rev'), at: this.now(), nextVersion });
    if (!res.duplicate) {
      this.emit('review.updated', { event: res.event, reviewState: stateOf([res.event]) }, { utteranceId: command.utteranceId, requestId: command.requestId, revision: res.event.resultRevision });
      if (res.version) {
        this.markVersion(res.task.taskId, res.version.version);
        this.emit('task.updated', { task: res.task, version: res.version }, { requestId: command.requestId });
      }
    }
    return res.event;
  }

  // ───────────────────────── 일지 ─────────────────────────

  async getTaskLog(taskId: string): Promise<TaskLog> {
    const repo = this.deps.repo;
    const task = await repo.getTask(taskId);
    if (!task) throw new EngineError('NOT_FOUND', '작업이 없습니다.', false);
    const [versions, sessions, utterances, notes, reviews] = await Promise.all([
      repo.listTaskVersions(taskId),
      repo.listSessions(taskId),
      repo.listUtterances(taskId),
      repo.listNotes(taskId),
      repo.listReviewEvents(taskId),
    ]);
    const entries: UtteranceLogEntry[] = [];
    for (const u of utterances) {
      const [results, translations] = await Promise.all([repo.listResults(u.utteranceId), repo.listTranslations(u.utteranceId)]);
      const evs = reviews.filter((r) => r.utteranceId === u.utteranceId);
      entries.push({ utterance: u, results, translations, reviewEvents: evs, reviewState: stateOf(evs) });
    }
    const latestKinds = entries.map((e) => e.results[e.results.length - 1]?.comparison.kind);
    return {
      task,
      versions,
      sessions,
      utterances: entries,
      notes,
      counts: {
        utterances: entries.length,
        differences: latestKinds.filter((k) => k === 'difference').length,
        ambiguous: latestKinds.filter((k) => k === 'ambiguous').length,
        reviewed: entries.filter((e) => e.reviewState === 'reviewed').length,
        dismissed: entries.filter((e) => e.reviewState === 'dismissed').length,
        applied: entries.filter((e) => e.reviewState === 'applied').length,
        taskChanges: Math.max(0, versions.length - 1),
      },
    };
  }

  async importTaskLog(json: string): Promise<Task> {
    let log: TaskLog;
    try {
      log = JSON.parse(json) as TaskLog;
    } catch {
      throw new EngineError('VALIDATION_FAILED', '일지 JSON 을 읽을 수 없습니다.', false);
    }
    if (!log?.task?.taskId || !Array.isArray(log.versions) || !Array.isArray(log.utterances)) {
      throw new EngineError('VALIDATION_FAILED', 'marinEar 일지 형식이 아닙니다.', false);
    }
    await this.deps.repo.importTaskLog(log);
    const active = log.versions.find((v) => v.version === log.task.activeVersion);
    this.activeVersionCache.set(log.task.taskId, log.task.activeVersion);
    if (active) this.emit('task.updated', { task: log.task, version: active });
    return log.task;
  }

  async exportTaskLog(taskId: string, format: ExportFormat): Promise<ExportedFile> {
    return exportLog(await this.getTaskLog(taskId), format, this.now());
  }
}

/** 마지막 확인 이벤트 기준 상태. apply 가 한 번이라도 있으면 applied */
export function stateOf(events: ReviewEvent[]): ReviewState {
  if (events.some((e) => e.action === 'apply')) return 'applied';
  const last = events[events.length - 1];
  if (!last) return 'unreviewed';
  return last.action === 'dismiss' ? 'dismissed' : 'reviewed';
}
