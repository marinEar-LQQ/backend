import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { AnalysisResult, ReviewCommand, Utterance } from '../src/contracts';
import { TaskLogRepository } from '../src/repositories/task-log-repository';

let n = 0;
const openRepo = () => TaskLogRepository.open(`test-${Date.now()}-${n++}`);
const AT = '2026-11-27T10:00:00.000Z';
const draft = { ownVessel: '해동호', targetVessel: 'A선박', terminalId: 'PNIT', berthId: 'T3', note: '' };

async function seed(repo: TaskLogRepository) {
  const { task } = await repo.saveTaskVersion('task-001', draft, undefined, AT);
  const utt: Utterance = { utteranceId: 'utt-1', sessionId: 'ses-1', taskId: task.taskId, taskVersion: 1, startMs: 0, endMs: 3000, capturedAt: AT, audioRefs: [], audioFlags: [] };
  await repo.putUtterance(utt);
  const result = { utteranceId: 'utt-1', revision: 2 } as AnalysisResult;
  await repo.putResult({ ...result, revision: 1 });
  await repo.putResult(result);
  return task;
}

const cmd = (over: Partial<ReviewCommand> = {}): ReviewCommand => ({
  requestId: 'req-1',
  utteranceId: 'utt-1',
  action: 'apply',
  expectedResultRevision: 2,
  expectedTaskVersion: 1,
  confirmedByUser: true,
  patch: { terminalId: 'HPNT' },
  ...over,
});

const next = { taskId: 'task-001', ownVessel: '해동호', targetVessel: 'A선박', terminalId: 'HPNT', berthId: 'T3', note: '' };

describe('TaskLogRepository', () => {
  it('작업 버전은 불변이고 새 버전으로만 증가', async () => {
    const repo = await openRepo();
    await repo.saveTaskVersion('task-001', draft, undefined, AT);
    const { version } = await repo.saveTaskVersion('task-001', { ...draft, berthId: 'T2' }, 1, AT);
    expect(version.version).toBe(2);
    expect((await repo.getTaskVersion('task-001', 1))?.berthId).toBe('T3');
  });

  it('오래된 expectedVersion 저장은 VERSION_CONFLICT', async () => {
    const repo = await openRepo();
    await repo.saveTaskVersion('task-001', draft, undefined, AT);
    await repo.saveTaskVersion('task-001', draft, 1, AT);
    await expect(repo.saveTaskVersion('task-001', draft, 1, AT)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('apply: 새 버전 + activeVersion + ReviewEvent 를 함께 저장', async () => {
    const repo = await openRepo();
    await seed(repo);
    const r = await repo.applyReview({ command: cmd(), eventId: 'ev-1', at: AT, nextVersion: next });
    expect(r.version?.version).toBe(2);
    expect(r.version?.sourceReviewEventId).toBe('ev-1');
    expect((await repo.getTask('task-001'))?.activeVersion).toBe(2);
    expect(await repo.listReviewEvents('task-001')).toHaveLength(1);
  });

  it('반복 apply (같은 requestId) → 중복 버전 없이 같은 이벤트', async () => {
    const repo = await openRepo();
    await seed(repo);
    await repo.applyReview({ command: cmd(), eventId: 'ev-1', at: AT, nextVersion: next });
    const again = await repo.applyReview({ command: cmd(), eventId: 'ev-2', at: AT, nextVersion: next });
    expect(again.duplicate).toBe(true);
    expect(again.event.eventId).toBe('ev-1');
    expect(await repo.listTaskVersions('task-001')).toHaveLength(2);
  });

  it('처리 중 작업 수정 → 반영 거절, 아무것도 저장되지 않음', async () => {
    const repo = await openRepo();
    await seed(repo);
    await repo.saveTaskVersion('task-001', { ...draft, note: '수정' }, 1, AT);
    await expect(repo.applyReview({ command: cmd(), eventId: 'ev-1', at: AT, nextVersion: next })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(await repo.listReviewEvents('task-001')).toHaveLength(0);
    expect(await repo.listTaskVersions('task-001')).toHaveLength(2);
  });

  it('오래된 결과 revision 으로 반영 → RESULT_STALE', async () => {
    const repo = await openRepo();
    await seed(repo);
    await expect(repo.applyReview({ command: cmd({ expectedResultRevision: 1 }), eventId: 'e', at: AT, nextVersion: next })).rejects.toMatchObject({ code: 'RESULT_STALE' });
  });

  it('같은 결과 revision 중복 수신은 무시', async () => {
    const repo = await openRepo();
    await seed(repo);
    expect(await repo.putResult({ utteranceId: 'utt-1', revision: 2 } as AnalysisResult)).toBe('duplicate');
    expect(await repo.listResults('utt-1')).toHaveLength(2);
  });

  it('review/dismiss 는 작업 기준을 바꾸지 않음', async () => {
    const repo = await openRepo();
    await seed(repo);
    const r = await repo.applyReview({ command: cmd({ action: 'review', patch: undefined }), eventId: 'ev-1', at: AT, nextVersion: null });
    expect(r.event.taskVersionAfter).toBe(1);
    expect((await repo.getTask('task-001'))?.activeVersion).toBe(1);
  });
});
