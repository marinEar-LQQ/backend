import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { AnalysisResult, AnyEngineEvent } from '../src/contracts';
import { MockEngineClient } from '../src/engine/mock-client';
import { DEMO_SCENARIO } from '../src/engine/fixtures/demo-scenario';

let n = 0;
async function setup() {
  const client = await MockEngineClient.create({ dbName: `engine-${Date.now()}-${n++}`, asrDelayMs: 0 });
  const events: AnyEngineEvent[] = [];
  client.subscribe((e) => events.push(e));
  const taskId = await client.seedDemoTask();
  await client.playScenario(taskId);
  const finals = events.filter((e) => e.type === 'analysis.final').map((e) => (e.payload as { result: AnalysisResult }).result);
  const latest = (i: number) => finals.filter((r) => r.utteranceId === finals.filter((x) => x.revision === 1)[i]!.utteranceId).at(-1)!;
  return { client, events, taskId, finals, latest };
}

describe('EngineCore + Mock (시연 시나리오 전체 흐름)', () => {
  it('합성 음성 6건 → 발화 6개, 각각 rev1(pending) → rev2(complete)', async () => {
    const { finals } = await setup();
    const rev1 = finals.filter((r) => r.revision === 1);
    const rev2 = finals.filter((r) => r.revision === 2);
    expect(rev1).toHaveLength(DEMO_SCENARIO.length);
    expect(rev2).toHaveLength(DEMO_SCENARIO.length);
    expect(rev1.every((r) => r.crossCheck === 'pending')).toBe(true);
    expect(rev2.every((r) => r.crossCheck === 'complete' && r.origin === 'fixture')).toBe(true);
  });

  it('사례별 최종 판정', async () => {
    const { latest } = await setup();
    expect([0, 1, 2, 3, 4, 5].map((i) => latest(i).comparison.kind)).toEqual(['difference', 'ambiguous', 'ambiguous', 'unrelated', 'match', 'match']);
  });

  it('사례 B: rev1(enhanced 만)은 difference 였다가 교차 검사 후 ambiguous 로 바뀐다', async () => {
    const { finals } = await setup();
    const bId = finals.filter((r) => r.revision === 1)[1]!.utteranceId;
    const [r1, r2] = finals.filter((r) => r.utteranceId === bId);
    expect(r1!.comparison.kind).toBe('difference');
    expect(r1!.comparison.reasonCodes).toContain('CROSS_CHECK_PENDING');
    expect(r2!.comparison.kind).toBe('ambiguous');
    expect(r2!.entities.terminalId).toBeNull();
  });

  it('번역: 보호 정보 복원, 불확실성 [HPNT / PNIT] 유지, 원문 유지', async () => {
    const { client, latest } = await setup();
    const b = latest(1);
    const id = await client.requestTranslation(b.utteranceId, b.revision, 'id');
    expect(id.status).toBe('ready');
    expect(id.text).toBe('Pekerjaan A선박 diubah ke [HPNT / PNIT] T3.');
    const ko = await client.requestTranslation(b.utteranceId, b.revision, 'ko');
    expect(ko.text).toBe('A선박 작업 [HPNT / PNIT] T3로 변경입니다.');
    const vi = await client.requestTranslation(b.utteranceId, b.revision, 'vi');
    expect(vi.status).toBe('unavailable');
    const m = latest(4);
    const my = await client.requestTranslation(m.utteranceId, m.revision, 'my');
    expect(my.text).toContain('14:30');
  });

  it('apply: 확인 후 새 작업 버전, 반복 apply 는 중복 없음, 오래된 버전은 거절', async () => {
    const { client, taskId, latest, events } = await setup();
    const a = latest(0);
    const cmd = { requestId: 'req-a', utteranceId: a.utteranceId, action: 'apply' as const, expectedResultRevision: 2, expectedTaskVersion: 1, confirmedByUser: true, patch: { terminalId: 'HPNT' } };
    await expect(client.reviewUtterance({ ...cmd, confirmedByUser: false, requestId: 'req-x' })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    const ev = await client.reviewUtterance(cmd);
    expect(ev.taskVersionAfter).toBe(2);
    const again = await client.reviewUtterance(cmd);
    expect(again.eventId).toBe(ev.eventId);
    expect(events.filter((e) => e.type === 'task.updated')).toHaveLength(2); // 등록 + 반영 1회

    const b = latest(1);
    await expect(
      client.reviewUtterance({ requestId: 'req-b', utteranceId: b.utteranceId, action: 'apply', expectedResultRevision: 2, expectedTaskVersion: 1, confirmedByUser: true, patch: { terminalId: 'PNIT' } }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const log = await client.getTaskLog(taskId);
    expect(log.versions.map((v) => v.terminalId)).toEqual(['PNIT', 'HPNT']);
    expect(log.counts).toMatchObject({ utterances: 6, differences: 1, ambiguous: 2, applied: 1, taskChanges: 1 });
    // 과거 발화의 비교 기준은 v1 그대로
    expect(log.utterances.every((u) => u.utterance.taskVersion === 1)).toBe(true);
  });

  it('dismiss 는 기준을 바꾸지 않음', async () => {
    const { client, taskId, latest } = await setup();
    const d = latest(3);
    await client.reviewUtterance({ requestId: 'req-d', utteranceId: d.utteranceId, action: 'dismiss', expectedResultRevision: 2, expectedTaskVersion: 1, confirmedByUser: true });
    const log = await client.getTaskLog(taskId);
    expect(log.task.activeVersion).toBe(1);
    expect(log.counts.dismissed).toBe(1);
  });

  it('원음/완화음 재생 클립과 일지 내보내기 (음성 미포함, 불확실성 유지)', async () => {
    const { client, taskId, latest } = await setup();
    const b = latest(1);
    const raw = await client.getAudioClip(b.utteranceId, 'raw');
    const enh = await client.getAudioClip(b.utteranceId, 'enhanced');
    expect(raw.status).toBe('available');
    expect(enh.status).toBe('available');
    const utt = (await client.getTaskLog(taskId)).utterances.find((u) => u.utterance.utteranceId === b.utteranceId)!.utterance;
    const [rawRef, enhRef] = ['raw', 'enhanced'].map((v) => utt.audioRefs.find((a) => a.variant === v)!);
    expect(rawRef!.sha256).not.toBe(enhRef!.sha256); // 원음과 완화음은 서로 다른 파일
    const txt = await client.exportTaskLog(taskId, 'txt');
    expect(txt.content).toContain('[시연 고정 데이터]');
    expect(txt.content).toContain('terminalId=[HPNT / PNIT]');
    const json = JSON.parse((await client.exportTaskLog(taskId, 'json')).content);
    expect(json.includesAudio).toBe(false);
  });

  it('작업 없이 세션을 열면 NOT_FOUND, 닫힌 세션에 입력하면 SESSION_CLOSED', async () => {
    const { client, taskId } = await setup();
    await expect(client.openSession('nope', 'file')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const s = await client.openSession(taskId, 'live');
    await client.closeSession(s.sessionId);
    await expect(
      client.appendAudio(s.sessionId, { sessionId: s.sessionId, seq: 0, startMs: 0, sampleRate: 16000, channels: 1, pcm: new Float32Array(160) }),
    ).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
  });
});

describe('importTaskLog (미리 분석한 결과 불러오기)', () => {
  it('내보낸 JSON 을 새 DB 로 가져오면 같은 일지가 보인다', async () => {
    const { client, taskId } = await setup();
    const json = (await client.exportTaskLog(taskId, 'json')).content;
    const other = await MockEngineClient.create({ dbName: `import-${Date.now()}`, asrDelayMs: 0 });
    const task = await other.importTaskLog(json);
    const log = await other.getTaskLog(task.taskId);
    expect(log.counts.utterances).toBe(DEMO_SCENARIO.length);
    expect(log.utterances[1]!.results.at(-1)!.comparison.kind).toBe('ambiguous');
    await expect(other.importTaskLog('{"x":1}')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
