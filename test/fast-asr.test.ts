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

/** 빠른 자막은 숫자를 틀리고(10노트), 정확한 모델은 맞게(12노트) 듣는 온라인 받아쓰기 흉내 */
class FakeOnlineAsr implements AsrProvider {
  readonly sampleRate = 16000 as const;
  readonly supportsFast = true;
  modelVersion = 'fake';
  calls: string[] = [];
  async transcribe(_pcm: Float32Array, ctx: AsrContext): Promise<Transcript> {
    const q = ctx.quality ?? 'accurate';
    this.calls.push(`${ctx.variant}:${q}`);
    const text = q === 'fast' ? '여기는 한라호입니다. 속도는 10노트입니다.' : '여기는 한라호입니다. 속도는 12노트입니다.';
    return { text, segments: [], modelVersion: q, wordAligned: false };
  }
}

describe('빠른 자막 먼저 → 정확한 모델로 확정 (온라인 모드)', () => {
  it('rev1 은 빠른 자막, rev2 는 완화음·원음 모두 정확한 결과로 확정', async () => {
    const repo = await TaskLogRepository.open(`fast-${Date.now()}`);
    const asr = new FakeOnlineAsr();
    const core = new EngineCore({ repo, catalog: DEMO_CATALOG, asr, translator: null, fixtureMode: false });
    const events: AnyEngineEvent[] = [];
    core.subscribe((e) => events.push(e));
    const { task } = await core.saveTask(DEMO_TASK_MONOLOGUE);
    await analyzePcm(core, task.taskId, synthesizeScenarioAudio(DEMO_SCENARIO.slice(0, 1)), 16000, { fileName: 'probe.wav' });
    await core.whenIdle();

    const finals = events.filter((e) => e.type === 'analysis.final').map((e) => (e.payload as { result: AnalysisResult }).result);
    const [r1, r2] = finals;
    expect(r1!.enhancedTranscript!.text).toContain('10노트');
    expect(r1!.crossCheck).toBe('pending');
    expect(r2!.enhancedTranscript!.text).toContain('12노트');
    expect(r2!.rawTranscript!.text).toContain('12노트');
    expect(r2!.entities.speed).toBe('12kn');
    // 정확한 모델 호출은 2번(완화음·원음) — 한도 부담은 예전과 같다
    expect(asr.calls.filter((c) => c.endsWith(':accurate'))).toHaveLength(2);
    expect(asr.calls[0]).toBe('enhanced:fast');
  });
});
