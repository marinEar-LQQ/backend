import {
  EngineError,
  type AssetManifest,
  type AudioClip,
  type AudioFrame,
  type AudioVariant,
  type EngineClient,
  type EngineEventListener,
  type ExportFormat,
  type ExportedFile,
  type LangCode,
  type LoadProgress,
  type Readiness,
  type ReviewCommand,
  type ReviewEvent,
  type SaveTaskResult,
  type Session,
  type SessionInputInfo,
  type SessionSource,
  type Task,
  type TaskDraft,
  type TaskLog,
  type TaskNote,
  type Translation,
} from '../contracts';
import type { WorkerCommand, WorkerEngineOptions, WorkerReply } from './worker-protocol';

/**
 * WorkerEngineClient — 기본 EngineClient adapter. 모든 호출을 Worker 로 보낸다.
 *
 * 사용 (Vite):
 *   import EngineWorker from 'marinear-engine/worker?worker';
 *   const engine = new WorkerEngineClient(new EngineWorker(), { allowRemote: true });
 */
export class WorkerEngineClient implements EngineClient {
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void; onProgress?: (p: LoadProgress) => void }>();
  private readonly listeners = new Set<EngineEventListener>();
  private counter = 0;

  constructor(private readonly worker: Worker, options: WorkerEngineOptions = {}) {
    worker.onmessage = (ev: MessageEvent<WorkerReply>) => this.onReply(ev.data);
    worker.postMessage({ kind: 'init', options });
  }

  private onReply(msg: WorkerReply): void {
    if (msg.kind === 'event') {
      for (const l of this.listeners) l(msg.event);
      return;
    }
    if (msg.kind === 'progress') {
      this.pending.get(msg.requestId)?.onProgress?.(msg.progress);
      return;
    }
    if (msg.kind === 'result') {
      const p = this.pending.get(msg.requestId);
      if (!p) return;
      this.pending.delete(msg.requestId);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(EngineError.from(msg.error));
    }
  }

  private call<T>(type: string, payload: unknown[], transfer: Transferable[] = [], onProgress?: (p: LoadProgress) => void): Promise<T> {
    const requestId = `req-${Date.now().toString(36)}-${(this.counter++).toString(36)}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject, ...(onProgress ? { onProgress } : {}) });
      const cmd: WorkerCommand = { kind: 'command', requestId, type, payload };
      this.worker.postMessage(cmd, transfer);
    });
  }

  subscribe(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {
    this.worker.terminate();
  }

  loadAssets(manifest: AssetManifest, onProgress?: (p: LoadProgress) => void): Promise<Readiness> {
    return this.call('loadAssets', [manifest], [], onProgress);
  }
  checkReadiness(): Promise<Readiness> {
    return this.call('checkReadiness', []);
  }
  saveTask(draft: TaskDraft, expectedVersion?: number): Promise<SaveTaskResult> {
    return this.call('saveTask', [draft, expectedVersion]);
  }
  listTasks(): Promise<Task[]> {
    return this.call('listTasks', []);
  }
  openSession(taskId: string, source: SessionSource, inputInfo?: SessionInputInfo): Promise<Session> {
    return this.call('openSession', [taskId, source, inputInfo]);
  }
  /** pcm 버퍼는 Worker 로 transfer 된다 — 호출 후 frame.pcm 을 다시 쓰지 말 것 */
  appendAudio(sessionId: string, frame: AudioFrame): Promise<void> {
    return this.call('appendAudio', [sessionId, frame], [frame.pcm.buffer]);
  }
  closeSession(sessionId: string): Promise<Session> {
    return this.call('closeSession', [sessionId]);
  }
  markDisconnected(sessionId: string): Promise<void> {
    return this.call('markDisconnected', [sessionId]);
  }
  requestTranslation(utteranceId: string, revision: number, lang: LangCode): Promise<Translation> {
    return this.call('requestTranslation', [utteranceId, revision, lang]);
  }
  getAudioClip(utteranceId: string, variant: AudioVariant, startMs?: number, endMs?: number): Promise<AudioClip> {
    return this.call('getAudioClip', [utteranceId, variant, startMs, endMs]);
  }
  reviewUtterance(command: ReviewCommand): Promise<ReviewEvent> {
    return this.call('reviewUtterance', [command]);
  }
  getTaskLog(taskId: string): Promise<TaskLog> {
    return this.call('getTaskLog', [taskId]);
  }
  exportTaskLog(taskId: string, format: ExportFormat): Promise<ExportedFile> {
    return this.call('exportTaskLog', [taskId, format]);
  }
  importTaskLog(json: string): Promise<Task> {
    return this.call('importTaskLog', [json]);
  }
  saveNote(taskId: string, text: string, noteId?: string): Promise<TaskNote> {
    return this.call('saveNote', [taskId, text, noteId]);
  }
}
