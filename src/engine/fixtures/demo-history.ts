import type { EngineClient, TaskDraft } from '../../contracts';
import { decodeWav } from '../audio/dsp';
import { analyzePcm } from '../file-input';
import { DEMO_TASK, DEMO_TASK_MONOLOGUE } from './demo-scenario';

/**
 * 시연 편의: "이미 처리한 작업"을 앱 DB 에 미리 쌓는다.
 * 팀 녹음을 시연 고정 데이터(FixtureAsr·FixtureTranslator)로 분석하므로 결과 origin=fixture ("시연 데이터" 배지),
 * 음성은 실제 녹음이 그대로 저장되어 "원음 듣기"가 실제 목소리로 재생된다.
 *
 *   지난 작업: 해동호 · PNIT T2 — 팀 대본 1~3 (잡음), 장소 차이는 교신대로 반영, 나머지 확인, 메모 + 작업 로그 저장
 *   지금 작업: 한라호 · 신선대부두 T2 — 독백 b(엔진 고장)·c(어선) 처리 완료. 독백 a 는 시연 때 직접 넣는다
 */

export interface DemoHistoryFile {
  /** 파일 이름 (TEAM_AUDIO_SCRIPT 키로 대본을 고른다: script1_noisy.wav, mono-b.wav …) */
  name: string;
  wav: ArrayBuffer;
}

export interface DemoHistoryResult {
  pastTaskId: string;
  currentTaskId: string;
  utterances: number;
}

/** 지난 작업 · 지금 작업에 넣을 녹음 (파일 이름의 일부) */
export const DEMO_HISTORY_PLAN = {
  past: ['script1_noisy', 'script2_noisy', 'script3_noisy'],
  current: ['mono-b', 'mono-c'],
} as const;

const NEEDS_CHECK = new Set(['difference', 'ambiguous']);

async function analyze(seeder: EngineClient & { whenIdle(): Promise<void> }, taskId: string, files: DemoHistoryFile[], names: readonly string[]): Promise<number> {
  let n = 0;
  for (const name of names) {
    const f = files.find((x) => x.name.includes(name));
    if (!f) continue;
    const { pcm, sampleRate } = decodeWav(f.wav);
    await analyzePcm(seeder, taskId, pcm, sampleRate, { fileName: f.name, fixtureMode: true });
    await seeder.whenIdle();
    n++;
  }
  return n;
}

/** 확인이 필요한 교신을 처리한다. applyDifference 면 분명한 장소 차이는 교신대로 기록 변경, 나머지는 확인 표시 */
async function checkAll(seeder: EngineClient, taskId: string, applyDifference: boolean, newId: (p: string) => string): Promise<void> {
  const log = await seeder.getTaskLog(taskId);
  let version = log.task.activeVersion;
  for (const u of log.utterances) {
    const r = u.results[u.results.length - 1];
    if (!r || !NEEDS_CHECK.has(r.comparison.kind) || u.reviewState !== 'unreviewed') continue;
    const canApply = applyDifference && r.comparison.kind === 'difference' && r.crossCheck === 'complete' && r.entities.terminalId && r.entities.berthId && r.uncertainties.length === 0;
    const ev = await seeder.reviewUtterance({
      requestId: newId('seed-review'),
      utteranceId: u.utterance.utteranceId,
      action: canApply ? 'apply' : 'review',
      expectedTaskVersion: version,
      expectedResultRevision: r.revision,
      confirmedByUser: true,
      ...(canApply ? { patch: { terminalId: r.entities.terminalId!, berthId: r.entities.berthId! } } : {}),
    });
    if (ev.taskVersionAfter) version = ev.taskVersionAfter;
  }
}

/** seeder: 시연 고정 데이터로 동작하는 엔진 (같은 저장소를 쓴다). 메인 엔진의 상태는 건드리지 않는다 */
export async function seedDemoHistory(
  seeder: EngineClient & { whenIdle(): Promise<void> },
  files: DemoHistoryFile[],
  newId: (p: string) => string,
): Promise<DemoHistoryResult> {
  // taskId 없이 저장 = 새 작업
  const save = async (draft: TaskDraft) => (await seeder.saveTask(draft)).task.taskId;

  // 지난 작업
  const pastTaskId = await save(DEMO_TASK);
  let utterances = await analyze(seeder, pastTaskId, files, DEMO_HISTORY_PLAN.past);
  await checkAll(seeder, pastTaskId, true, newId);
  await seeder.saveNote(pastTaskId, '관제에 HPNT 2번 변경 재확인함. 다음 당직자에게 인계.');
  const past = await seeder.getTaskLog(pastTaskId);
  const checked = past.counts.reviewed + past.counts.dismissed + past.counts.applied;
  await seeder.saveNote(pastTaskId, `작업 로그 저장 · 교신 ${past.counts.utterances}건 · 확인 ${checked}건 · 미확인 0건`);

  // 지금 작업 (가장 나중에 바뀐 작업이 앱을 열 때 현재 작업이 된다)
  const currentTaskId = await save(DEMO_TASK_MONOLOGUE);
  utterances += await analyze(seeder, currentTaskId, files, DEMO_HISTORY_PLAN.current);
  await checkAll(seeder, currentTaskId, false, newId);

  return { pastTaskId, currentTaskId, utterances };
}
