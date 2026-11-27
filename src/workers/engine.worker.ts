/// <reference lib="webworker" />
import { EngineError, type AudioFrame, type EngineClient } from '../contracts';
import { TaskLogRepository } from '../repositories/task-log-repository';
import { AssetManager } from '../engine/assets/asset-manager';
import { DEMO_CATALOG } from '../engine/catalog/demo-catalog';
import { EngineCore } from '../engine/core';
import { FixtureAsr, FixtureTranslator } from '../engine/fixtures/fixture-providers';
import { OnlineAssets } from '../engine/online/online-providers';
import type { WorkerCommand, WorkerInit, WorkerReply } from '../engine/worker-protocol';

/**
 * Worker 진입점. 모델 로딩·분석·저장을 모두 여기서 처리해 UI 스레드를 막지 않는다.
 * 제어 명령은 requestId 로 중복 처리를 막는다 (같은 requestId 재전송 시 같은 결과).
 */
declare const self: DedicatedWorkerGlobalScope;

let core: EngineCore | null = null;
let initPromise: Promise<EngineCore> | null = null;
const inflight = new Map<string, Promise<unknown>>();
const done = new Map<string, WorkerReply>();

function post(msg: WorkerReply, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

async function init(msg: WorkerInit): Promise<EngineCore> {
  const o = msg.options;
  const repo = await TaskLogRepository.open(o.dbName ?? 'marinear');
  const c = o.fixtureMode
    ? new EngineCore({ repo, catalog: DEMO_CATALOG, asr: new FixtureAsr(), translator: new FixtureTranslator(), fixtureMode: true })
    : o.mode === 'online'
      ? new EngineCore({
          repo,
          catalog: DEMO_CATALOG,
          mode: 'online',
          assets: new OnlineAssets((o.proxyUrl ?? 'http://localhost:8787').replace(/\/$/, ''), DEMO_CATALOG.terminals.map((t) => t.terminalId)),
        })
      : new EngineCore({
        repo,
        catalog: DEMO_CATALOG,
        assets: new AssetManager({
          allowRemote: o.allowRemote ?? true,
          ...(o.device ? { device: o.device } : {}),
          ...(o.localModelPath ? { localModelPath: o.localModelPath } : {}),
          ...(o.skipTranslation ? { skipTranslation: true } : {}),
        }),
      });
  c.subscribe((event) => post({ kind: 'event', event }));
  core = c;
  post({ kind: 'ready' });
  return c;
}

const METHODS = new Set<keyof EngineClient | 'markDisconnected'>([
  'loadAssets', 'checkReadiness', 'saveTask', 'openSession', 'appendAudio', 'closeSession', 'requestTranslation',
  'getAudioClip', 'reviewUtterance', 'getTaskLog', 'exportTaskLog', 'saveNote', 'listTasks', 'markDisconnected', 'importTaskLog', 'seedDemoHistory',
]);

async function handle(cmd: WorkerCommand): Promise<void> {
  const prior = done.get(cmd.requestId);
  if (prior) return post(prior);
  if (inflight.has(cmd.requestId)) return;

  const run = (async () => {
    const c = core ?? (await initPromise);
    if (!c) throw new EngineError('MODEL_NOT_READY', '엔진이 초기화되지 않았습니다.', true);
    if (!METHODS.has(cmd.type as keyof EngineClient)) throw new EngineError('VALIDATION_FAILED', `알 수 없는 명령: ${cmd.type}`, false);
    const args = [...cmd.payload];
    if (cmd.type === 'loadAssets') args[1] = (progress: unknown) => post({ kind: 'progress', requestId: cmd.requestId, progress: progress as never });
    if (cmd.type === 'appendAudio') {
      const frame = args[1] as AudioFrame;
      if (!(frame.pcm instanceof Float32Array)) frame.pcm = new Float32Array(frame.pcm as ArrayLike<number>);
    }
    const fn = (c as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[cmd.type]!;
    return fn.apply(c, args);
  })();
  inflight.set(cmd.requestId, run);

  let reply: WorkerReply;
  try {
    reply = { kind: 'result', requestId: cmd.requestId, ok: true, value: await run };
  } catch (e) {
    const err = e instanceof EngineError ? e : new EngineError('INTERNAL', String((e as Error)?.message ?? e), true);
    reply = { kind: 'result', requestId: cmd.requestId, ok: false, error: err.toPayload() };
  } finally {
    inflight.delete(cmd.requestId);
  }
  // 오디오 프레임은 결과를 캐시하지 않는다 (seq 로 중복/누락 판단)
  if (cmd.type !== 'appendAudio') {
    done.set(cmd.requestId, reply);
    if (done.size > 500) done.delete(done.keys().next().value!);
  }
  post(reply);
}

self.onmessage = (ev: MessageEvent<WorkerInit | WorkerCommand>) => {
  const msg = ev.data;
  if (msg.kind === 'init') {
    initPromise ??= init(msg);
    return;
  }
  if (msg.kind === 'command') void handle(msg);
};
