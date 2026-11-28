import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { AnalysisResult, AnyEngineEvent, Transcript } from '../src/contracts';
import { DEMO_CATALOG } from '../src/engine/catalog/demo-catalog';
import { EngineCore } from '../src/engine/core';
import { analyzePcm } from '../src/engine/file-input';
import { DEMO_SCENARIO, DEMO_TASK_MONOLOGUE } from '../src/engine/fixtures/demo-scenario';
import { synthesizeScenarioAudio } from '../src/engine/fixtures/fixture-providers';
import type { AsrContext, AsrProvider } from '../src/engine/providers';
import { TaskLogRepository } from '../src/repositories/task-log-repository';

/** 온라인 받아쓰기 흉내: 호출 순서·동시 실행을 기록한다. failRaw 면 원음 인식이 실패한다 */
class FakeOnlineAsr implements AsrProvider {
  readonly sampleRate = 16000 as const;
  modelVersion = 'fake';
  calls: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  constructor(private readonly failRaw = false) {}
  async transcribe(_pcm: Float32Array, ctx: AsrContext): Promise<Transcript> {
    this.calls.push(`${ctx.variant}:${ctx.quality ?? 'accurate'}`);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setTimeout(r, 20));
    this.inFlight--;
    if (this.failRaw && ctx.variant === 'raw') throw new Error('quota');
    return { text: '여기는 한라호입니다. 속도는 12노트입니다.', segments: [], modelVersion: 'accurate', wordAligned: false };
  }
}

async function run(asr: FakeOnlineAsr) {
  const repo = await TaskLogRepository.open(`online-${Date.now()}-${Math.random()}`);
  const core = new EngineCore({ repo, catalog: DEMO_CATALOG, asr, translator: null, fixtureMode: false });
  const events: AnyEngineEvent[] = [];
  core.subscribe((e) => events.push(e));
  const { task } = await core.saveTask(DEMO_TASK_MONOLOGUE);
  await analyzePcm(core, task.taskId, synthesizeScenarioAudio(DEMO_SCENARIO.slice(0, 1)), 16000, { fileName: 'probe.wav' });
  await core.whenIdle();
  const finals = events.filter((e) => e.type === 'analysis.final').map((e) => (e.payload as { result: AnalysisResult }).result);
  return { finals, events };
}

describe('온라인 받아쓰기: 완화음·원음을 동시에, 결과는 한 번', () => {
  it('호출 2번(둘 다 정확한 모델), 동시에 실행, 결과 1건', async () => {
    const asr = new FakeOnlineAsr();
    const { finals } = await run(asr);
    expect(asr.calls.sort()).toEqual(['enhanced:accurate', 'raw:accurate']);
    expect(asr.maxInFlight).toBe(2);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.crossCheck).toBe('complete');
    expect(finals[0]!.entities.speed).toBe('12kn');
  });

  it('원음 인식이 실패하면 교차 검사 불가로 한 번만 낸다', async () => {
    const asr = new FakeOnlineAsr(true);
    const { finals, events } = await run(asr);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.crossCheck).toBe('unavailable');
    expect(finals[0]!.rawTranscript).toBeNull();
    expect(events.some((e) => e.type === 'engine.error')).toBe(true);
  });
});
