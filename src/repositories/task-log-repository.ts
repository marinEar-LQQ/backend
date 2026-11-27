import {
  EngineError,
  type AnalysisResult,
  type IsoTime,
  type ReviewCommand,
  type ReviewEvent,
  type Session,
  type Task,
  type TaskDraft,
  type TaskNote,
  type TaskVersion,
  type Translation,
  type Utterance,
  type TaskLog,
} from '../contracts';
import { openDatabase, req, transact } from './idb';

export interface AudioBlobRecord {
  blobId: string;
  blob: Blob;
  mediaType: string;
  sampleRate: number;
  sha256: string | null;
  status: 'available' | 'deleted';
  createdAt: IsoTime;
}

export interface ApplyReviewInput {
  command: ReviewCommand;
  eventId: string;
  at: IsoTime;
  /** action=apply 일 때 새로 만들 버전 내용 (core 가 검증 완료한 값) */
  nextVersion: Omit<TaskVersion, 'version' | 'createdAt' | 'sourceReviewEventId'> | null;
}

function mapStorageError(e: unknown): never {
  if (e instanceof EngineError) throw e;
  const name = (e as { name?: string })?.name;
  if (name === 'QuotaExceededError') throw new EngineError('STORAGE_FULL', '저장 공간이 부족해 저장하지 못했습니다.', true);
  throw new EngineError('INTERNAL', `저장 오류: ${String((e as Error)?.message ?? e)}`, true);
}

/**
 * TaskLogRepository — 작업 버전·발화·분석 revision·번역·확인 이벤트·메모·음성 저장 (백엔드 06장).
 * 작업 버전은 불변이고, 새 버전 + activeVersion + ReviewEvent 는 한 트랜잭션으로 저장한다.
 */
export class TaskLogRepository {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name = 'marinear', factory?: IDBFactory): Promise<TaskLogRepository> {
    return new TaskLogRepository(await openDatabase(name, factory));
  }

  close(): void {
    this.db.close();
  }

  // ───────── 작업 ─────────

  async listTasks(): Promise<Task[]> {
    return transact(this.db, ['tasks'], 'readonly', (tx) => req(tx.objectStore('tasks').getAll() as IDBRequest<Task[]>));
  }

  async getTask(taskId: string): Promise<Task | null> {
    return transact(this.db, ['tasks'], 'readonly', async (tx) => (await req(tx.objectStore('tasks').get(taskId))) ?? null);
  }

  async getTaskVersion(taskId: string, version: number): Promise<TaskVersion | null> {
    return transact(this.db, ['taskVersions'], 'readonly', async (tx) => (await req(tx.objectStore('taskVersions').get([taskId, version]))) ?? null);
  }

  async getActiveVersion(taskId: string): Promise<TaskVersion | null> {
    const task = await this.getTask(taskId);
    return task ? this.getTaskVersion(taskId, task.activeVersion) : null;
  }

  async listTaskVersions(taskId: string): Promise<TaskVersion[]> {
    return transact(this.db, ['taskVersions'], 'readonly', async (tx) => {
      const all = (await req(tx.objectStore('taskVersions').index('byTask').getAll(taskId))) as TaskVersion[];
      return all.sort((a, b) => a.version - b.version);
    });
  }

  /** 작업 직접 등록/수정. 기존 작업이면 expectedVersion 이 activeVersion 과 같아야 한다. */
  async saveTaskVersion(taskId: string, draft: TaskDraft, expectedVersion: number | undefined, at: IsoTime): Promise<{ task: Task; version: TaskVersion }> {
    try {
      return await transact(this.db, ['tasks', 'taskVersions'], 'readwrite', async (tx) => {
        const tasks = tx.objectStore('tasks');
        const existing = (await req(tasks.get(taskId))) as Task | undefined;
        if (existing && expectedVersion !== existing.activeVersion) {
          throw new EngineError('VERSION_CONFLICT', '작업 기준이 그 사이 바뀌었습니다. 최신 기준을 다시 확인하세요.', true, {
            expectedVersion: expectedVersion ?? null,
            activeVersion: existing.activeVersion,
          });
        }
        if (!existing && expectedVersion !== undefined && expectedVersion !== 0) {
          throw new EngineError('NOT_FOUND', '작업이 없습니다.', false, { taskId });
        }
        const versionNo = (existing?.activeVersion ?? 0) + 1;
        const version: TaskVersion = {
          taskId,
          version: versionNo,
          ownVessel: draft.ownVessel.trim(),
          targetVessel: draft.targetVessel.trim(),
          terminalId: draft.terminalId,
          berthId: draft.berthId,
          note: draft.note,
          createdAt: at,
          sourceReviewEventId: null,
        };
        const task: Task = { taskId, activeVersion: versionNo, createdAt: existing?.createdAt ?? at, updatedAt: at };
        await req(tx.objectStore('taskVersions').add(version));
        await req(tasks.put(task));
        return { task, version };
      });
    } catch (e) {
      return mapStorageError(e);
    }
  }

  // ───────── 세션·발화·결과 ─────────

  async putSession(s: Session): Promise<void> {
    await this.put('sessions', s);
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.get<Session>('sessions', sessionId);
  }

  async listSessions(taskId: string): Promise<Session[]> {
    return this.byIndex<Session>('sessions', 'byTask', taskId);
  }

  async putUtterance(u: Utterance): Promise<void> {
    await this.put('utterances', u);
  }

  async getUtterance(id: string): Promise<Utterance | null> {
    return this.get<Utterance>('utterances', id);
  }

  async listUtterances(taskId: string): Promise<Utterance[]> {
    const list = await this.byIndex<Utterance>('utterances', 'byTask', taskId);
    return list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.startMs - b.startMs);
  }

  /** revision 은 단조 증가. 같은 revision 재저장은 무시(중복 수신), 더 낮은 revision 은 거절. */
  async putResult(r: AnalysisResult): Promise<'stored' | 'duplicate'> {
    try {
      return await transact(this.db, ['results'], 'readwrite', async (tx) => {
        const store = tx.objectStore('results');
        const existing = (await req(store.index('byUtterance').getAll(r.utteranceId))) as AnalysisResult[];
        const max = existing.reduce((m, x) => Math.max(m, x.revision), 0);
        if (existing.some((x) => x.revision === r.revision)) return 'duplicate';
        if (r.revision < max) throw new EngineError('RESULT_STALE', `revision ${r.revision} < 최신 ${max}`, false);
        await req(store.add(r));
        return 'stored';
      });
    } catch (e) {
      return mapStorageError(e);
    }
  }

  async listResults(utteranceId: string): Promise<AnalysisResult[]> {
    const list = await this.byIndex<AnalysisResult>('results', 'byUtterance', utteranceId);
    return list.sort((a, b) => a.revision - b.revision);
  }

  async latestResult(utteranceId: string): Promise<AnalysisResult | null> {
    const list = await this.listResults(utteranceId);
    return list[list.length - 1] ?? null;
  }

  async putTranslation(t: Translation): Promise<void> {
    await this.put('translations', t);
  }

  async getTranslation(utteranceId: string, sourceRevision: number, lang: string): Promise<Translation | null> {
    return this.get<Translation>('translations', [utteranceId, sourceRevision, lang]);
  }

  async listTranslations(utteranceId: string): Promise<Translation[]> {
    return this.byIndex<Translation>('translations', 'byUtterance', utteranceId);
  }

  // ───────── 확인·반영 ─────────

  async findReviewByRequest(requestId: string): Promise<ReviewEvent | null> {
    return transact(this.db, ['reviewEvents'], 'readonly', async (tx) => (await req(tx.objectStore('reviewEvents').index('byRequest').get(requestId))) ?? null);
  }

  /**
   * 원자적 기록 반영. 한 트랜잭션 안에서
   *  멱등 키 확인 → 작업 버전 확인 → 결과 revision 확인 → (apply 면) 새 버전 + activeVersion → ReviewEvent 저장.
   * 하나라도 실패하면 전부 취소된다.
   */
  async applyReview(input: ApplyReviewInput): Promise<{ event: ReviewEvent; task: Task; version: TaskVersion | null; duplicate: boolean }> {
    const { command, eventId, at, nextVersion } = input;
    try {
      return await transact(this.db, ['tasks', 'taskVersions', 'reviewEvents', 'results', 'utterances'], 'readwrite', async (tx) => {
        const reviews = tx.objectStore('reviewEvents');
        const prior = (await req(reviews.index('byRequest').get(command.requestId))) as ReviewEvent | undefined;
        const utt = (await req(tx.objectStore('utterances').get(command.utteranceId))) as Utterance | undefined;
        if (!utt) throw new EngineError('NOT_FOUND', '발화를 찾을 수 없습니다.', false);
        const tasks = tx.objectStore('tasks');
        const task = (await req(tasks.get(utt.taskId))) as Task | undefined;
        if (!task) throw new EngineError('NOT_FOUND', '작업을 찾을 수 없습니다.', false);

        if (prior) {
          const v = prior.action === 'apply' ? ((await req(tx.objectStore('taskVersions').get([task.taskId, prior.taskVersionAfter]))) as TaskVersion) : null;
          return { event: prior, task, version: v, duplicate: true };
        }
        if (task.activeVersion !== command.expectedTaskVersion) {
          throw new EngineError('VERSION_CONFLICT', '작업 기준이 그 사이 바뀌었습니다.', true, {
            expectedTaskVersion: command.expectedTaskVersion,
            activeVersion: task.activeVersion,
          });
        }
        const results = (await req(tx.objectStore('results').index('byUtterance').getAll(command.utteranceId))) as AnalysisResult[];
        const latest = results.reduce((m, x) => Math.max(m, x.revision), 0);
        if (latest !== command.expectedResultRevision) {
          throw new EngineError('RESULT_STALE', '분석 결과가 갱신되었습니다. 최신 결과를 다시 확인하세요.', true, {
            expectedResultRevision: command.expectedResultRevision,
            latestRevision: latest,
          });
        }

        let version: TaskVersion | null = null;
        let updatedTask = task;
        if (command.action === 'apply') {
          if (!nextVersion) throw new EngineError('VALIDATION_FAILED', 'apply 에는 새 버전 내용이 필요합니다.', false);
          version = { ...nextVersion, taskId: task.taskId, version: task.activeVersion + 1, createdAt: at, sourceReviewEventId: eventId };
          updatedTask = { ...task, activeVersion: version.version, updatedAt: at };
          await req(tx.objectStore('taskVersions').add(version));
          await req(tasks.put(updatedTask));
        }
        const event: ReviewEvent = {
          eventId,
          requestId: command.requestId,
          utteranceId: command.utteranceId,
          taskId: task.taskId,
          resultRevision: command.expectedResultRevision,
          action: command.action,
          at,
          confirmedByUser: command.confirmedByUser,
          taskVersionBefore: task.activeVersion,
          taskVersionAfter: updatedTask.activeVersion,
          patch: command.patch ?? null,
          note: command.note ?? null,
        };
        await req(reviews.add(event));
        return { event, task: updatedTask, version, duplicate: false };
      });
    } catch (e) {
      return mapStorageError(e);
    }
  }

  async listReviewEvents(taskId: string): Promise<ReviewEvent[]> {
    const list = await this.byIndex<ReviewEvent>('reviewEvents', 'byTask', taskId);
    return list.sort((a, b) => a.at.localeCompare(b.at));
  }

  // ───────── 가져오기 ─────────

  /** exportTaskLog(json) 으로 내보낸 일지를 한 트랜잭션으로 가져온다 (같은 ID 는 덮어씀). 음성 파일은 포함되지 않는다 */
  async importTaskLog(log: TaskLog): Promise<void> {
    try {
      await transact(this.db, ['tasks', 'taskVersions', 'sessions', 'utterances', 'results', 'translations', 'reviewEvents', 'notes'], 'readwrite', async (tx) => {
        const put = (store: string, v: unknown) => req(tx.objectStore(store).put(v));
        await put('tasks', log.task);
        for (const v of log.versions) await put('taskVersions', v);
        for (const v of log.sessions) await put('sessions', v);
        for (const e of log.utterances) {
          await put('utterances', e.utterance);
          for (const r of e.results) await put('results', r);
          for (const t of e.translations) await put('translations', t);
          for (const r of e.reviewEvents) await put('reviewEvents', r);
        }
        for (const n of log.notes) await put('notes', n);
      });
    } catch (e) {
      mapStorageError(e);
    }
  }

  // ───────── 메모 ─────────

  async putNote(n: TaskNote): Promise<void> {
    await this.put('notes', n);
  }

  async listNotes(taskId: string): Promise<TaskNote[]> {
    const list = await this.byIndex<TaskNote>('notes', 'byTask', taskId);
    return list.sort((a, b) => a.at.localeCompare(b.at));
  }

  // ───────── 음성 ─────────

  async putAudio(rec: AudioBlobRecord): Promise<void> {
    await this.put('audioBlobs', rec);
  }

  async getAudio(blobId: string): Promise<AudioBlobRecord | null> {
    return this.get<AudioBlobRecord>('audioBlobs', blobId);
  }

  /** 음성 삭제: 참조는 끊지 않고 deleted 상태만 남긴다 */
  async markAudioDeleted(blobId: string): Promise<void> {
    const rec = await this.getAudio(blobId);
    if (rec) await this.put('audioBlobs', { ...rec, blob: new Blob([]), status: 'deleted' });
  }

  // ───────── 내부 ─────────

  private async put(store: Parameters<typeof transact>[1][number], value: unknown): Promise<void> {
    try {
      await transact(this.db, [store], 'readwrite', async (tx) => {
        await req(tx.objectStore(store).put(value));
      });
    } catch (e) {
      mapStorageError(e);
    }
  }

  private async get<T>(store: Parameters<typeof transact>[1][number], key: IDBValidKey): Promise<T | null> {
    return transact(this.db, [store], 'readonly', async (tx) => ((await req(tx.objectStore(store).get(key))) as T | undefined) ?? null);
  }

  private async byIndex<T>(store: Parameters<typeof transact>[1][number], index: string, key: IDBValidKey): Promise<T[]> {
    return transact(this.db, [store], 'readonly', async (tx) => (await req(tx.objectStore(store).index(index).getAll(key))) as T[]);
  }
}
