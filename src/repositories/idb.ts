/** 아주 얇은 IndexedDB promise 래퍼. 트랜잭션 안에서는 IDB 요청만 await 해야 한다. */

export const DB_VERSION = 1;

export type StoreName =
  | 'tasks'
  | 'taskVersions'
  | 'sessions'
  | 'utterances'
  | 'results'
  | 'translations'
  | 'reviewEvents'
  | 'notes'
  | 'audioBlobs';

export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function openDatabase(name: string, factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(name, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      // migration: 버전이 올라가면 oldVersion 기준으로 단계별 추가한다.
      const tasks = db.createObjectStore('tasks', { keyPath: 'taskId' });
      tasks.createIndex('updatedAt', 'updatedAt');
      const versions = db.createObjectStore('taskVersions', { keyPath: ['taskId', 'version'] });
      versions.createIndex('byTask', 'taskId');
      const sessions = db.createObjectStore('sessions', { keyPath: 'sessionId' });
      sessions.createIndex('byTask', 'taskId');
      const utts = db.createObjectStore('utterances', { keyPath: 'utteranceId' });
      utts.createIndex('byTask', 'taskId');
      utts.createIndex('bySession', 'sessionId');
      const results = db.createObjectStore('results', { keyPath: ['utteranceId', 'revision'] });
      results.createIndex('byUtterance', 'utteranceId');
      const trs = db.createObjectStore('translations', { keyPath: ['utteranceId', 'sourceRevision', 'targetLang'] });
      trs.createIndex('byUtterance', 'utteranceId');
      const reviews = db.createObjectStore('reviewEvents', { keyPath: 'eventId' });
      reviews.createIndex('byUtterance', 'utteranceId');
      reviews.createIndex('byTask', 'taskId');
      reviews.createIndex('byRequest', 'requestId', { unique: true });
      const notes = db.createObjectStore('notes', { keyPath: 'noteId' });
      notes.createIndex('byTask', 'taskId');
      db.createObjectStore('audioBlobs', { keyPath: 'blobId' });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

/**
 * 하나의 트랜잭션으로 fn 실행. fn 이 throw 하면 abort 해서 부분 저장이 남지 않는다.
 * 완료(oncomplete) 후에만 resolve — "저장 실패 시 저장 완료 이벤트를 발행하지 않는다" 의 근거.
 */
export function transact<T>(
  db: IDBDatabase,
  stores: StoreName[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores, mode);
    } catch (e) {
      reject(e);
      return;
    }
    let result: T;
    let failure: unknown = null;
    tx.oncomplete = () => (failure ? reject(failure) : resolve(result));
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('transaction aborted'));
    tx.onerror = () => {
      /* onabort 에서 처리 */
    };
    fn(tx).then(
      (r) => {
        result = r;
      },
      (e) => {
        failure = e;
        try {
          tx.abort();
        } catch {
          reject(e);
        }
      },
    );
  });
}
