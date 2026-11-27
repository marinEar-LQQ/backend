import type { CatalogManifest, Session } from '../contracts';
import { TaskLogRepository } from '../repositories/task-log-repository';
import { DEMO_CATALOG } from './catalog/demo-catalog';
import { EngineCore } from './core';
import { analyzePcm } from './file-input';
import { DEMO_SCENARIO, DEMO_TASK, DEMO_TASK_MONOLOGUE, type DemoLine } from './fixtures/demo-scenario';
import { FixtureAsr, FixtureTranslator, synthesizeScenarioAudio } from './fixtures/fixture-providers';

export interface MockEngineOptions {
  dbName?: string;
  catalog?: CatalogManifest;
  lines?: DemoLine[];
  asrDelayMs?: number;
  factory?: IDBFactory;
}

/**
 * MockEngineClient — 화면 검증용. 실제 엔진과 같은 EngineCore·규칙·IndexedDB 를 쓰고,
 * ASR/번역만 시연 고정 데이터로 바꾼다 (결과 origin='fixture', session.inputInfo.fixtureMode=true).
 * 메인 스레드에서 바로 동작하므로 Worker 없이 화면 개발이 가능하다.
 */
export class MockEngineClient extends EngineCore {
  private constructor(
    repo: TaskLogRepository,
    catalog: CatalogManifest,
    private readonly lines: DemoLine[],
    asrDelayMs: number,
  ) {
    super({
      repo,
      catalog,
      asr: new FixtureAsr(lines, asrDelayMs),
      translator: new FixtureTranslator(),
      fixtureMode: true,
    });
  }

  static async create(opts: MockEngineOptions = {}): Promise<MockEngineClient> {
    const repo = await TaskLogRepository.open(opts.dbName ?? 'marinear-mock', opts.factory);
    return new MockEngineClient(repo, opts.catalog ?? DEMO_CATALOG, opts.lines ?? DEMO_SCENARIO, opts.asrDelayMs ?? 250);
  }

  /** 시연 작업 등록. script = 대본 1~3(현대부산호, PNIT 2번), monologue = 독백 녹음(한라호, 신선대부두 2번) */
  async seedDemoTask(kind: 'script' | 'monologue' = 'script'): Promise<string> {
    const { task } = await this.saveTask(kind === 'monologue' ? DEMO_TASK_MONOLOGUE : DEMO_TASK);
    return task.taskId;
  }

  /** 시연 시나리오 전체를 합성 음성으로 흘려보낸다. 끝나면 모든 분석이 완료된 상태. */
  async playScenario(taskId: string): Promise<Session> {
    const sr = 16000;
    const pcm = synthesizeScenarioAudio(this.lines, sr);
    const session = await analyzePcm(this, taskId, pcm, sr, { fileName: 'demo-scenario (합성)', fixtureMode: true });
    await this.whenIdle();
    return session;
  }
}
