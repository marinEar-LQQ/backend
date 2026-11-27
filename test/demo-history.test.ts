import 'fake-indexeddb/auto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AnyEngineEvent } from '../src/contracts';
import { DEMO_CATALOG } from '../src/engine/catalog/demo-catalog';
import { EngineCore } from '../src/engine/core';
import { DEMO_HISTORY_PLAN } from '../src/engine/fixtures/demo-history';
import { TaskLogRepository } from '../src/repositories/task-log-repository';

const wav = (p: string) => {
  const b = fs.readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe('시연 편의: 처리한 작업 미리 쌓기', () => {
  it('지난 작업(처리·메모·저장) + 지금 작업(교신 2건 처리), 음성 보존, 지금 작업을 현재로 알림', async () => {
    const repo = await TaskLogRepository.open(`seed-${Date.now()}`);
    // 메인 엔진은 받아쓰기 부품이 없어도 된다 — 쌓기는 시연 고정 데이터 엔진이 한다
    const core = new EngineCore({ repo, catalog: DEMO_CATALOG, asr: null, translator: null });
    const events: AnyEngineEvent[] = [];
    core.subscribe((e) => events.push(e));
    const files = [
      ...DEMO_HISTORY_PLAN.past.map((n) => ({ name: `${n}.wav`, wav: wav(`fixtures/audio/team/${n}.wav`) })),
      ...[...DEMO_HISTORY_PLAN.current, ...DEMO_HISTORY_PLAN.pending].map((n) => ({ name: `${n}.wav`, wav: wav(`fixtures/audio/team3/${n}.wav`) })),
    ];
    const res = await core.seedDemoHistory(files);
    expect(res.utterances).toBe(6);

    const past = await core.getTaskLog(res.pastTaskId);
    expect(past.utterances.length).toBeGreaterThan(5);
    // 확인이 필요한 교신은 모두 처리됨, 장소 차이는 교신대로 반영(v2)
    const pending = past.utterances.filter((u) => ['difference', 'ambiguous'].includes(u.results.at(-1)!.comparison.kind) && u.reviewState === 'unreviewed');
    expect(pending).toEqual([]);
    expect(past.task.activeVersion).toBeGreaterThan(1);
    expect(past.notes.map((n) => n.text)).toEqual(expect.arrayContaining([expect.stringMatching(/^작업 로그 저장 ·/)]));
    expect(past.utterances.every((u) => u.results.at(-1)!.origin === 'fixture')).toBe(true);

    const current = await core.getTaskLog(res.currentTaskId);
    expect(current.utterances.length).toBeGreaterThanOrEqual(2);
    // 장소 차이 교신 1건은 확인 전 상태로 남는다 (등록 T2, 교신 3번)
    const open = current.utterances.filter((u) => u.reviewState === 'unreviewed' && u.results.at(-1)!.comparison.kind === 'difference');
    expect(open.length).toBe(1);
    // 시각이 벌어져 있다: 모두 같은 시각이 아니고, 미래 시각도 없다
    const times = [...past.utterances, ...current.utterances].map((u) => u.utterance.capturedAt);
    expect(new Set(times.map((t) => t.slice(0, 16))).size).toBeGreaterThan(3);
    expect(times.every((t) => t <= new Date().toISOString())).toBe(true);
    // 앱을 다시 열어도 지금 작업이 현재 작업 (갱신 시각이 가장 최근)
    const tasks = [...(await core.listTasks())].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    expect(tasks[0]!.taskId).toBe(res.currentTaskId);
    // 원음 듣기: 실제 녹음이 저장되어 있다
    const clip = await core.getAudioClip(current.utterances[0]!.utterance.utteranceId, 'raw');
    expect(clip.status).toBe('available');
    // 앱이 지금 작업으로 전환되도록 알림
    const last = events.filter((e) => e.type === 'task.updated').at(-1)!;
    expect((last.payload as { task: { taskId: string } }).task.taskId).toBe(res.currentTaskId);
  }, 30000);
});
