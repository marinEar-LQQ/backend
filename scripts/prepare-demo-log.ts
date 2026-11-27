/**
 * 시연 준비: 시연 녹음을 "실제 모델"(whisper-small + Opus-MT, 브라우저와 같은 q8)로 미리 분석하고
 * en/id/vi 번역까지 만들어 둔 일지 JSON 을 저장한다. 시연 때 importTaskLog(json) 으로 불러오면
 * 10초 대기 없이 결과를 보여 줄 수 있다. 결과의 origin 은 'model' — 시연 고정 데이터가 아니다.
 *
 *   npx vite-node --config vitest.config.ts scripts/prepare-demo-log.ts
 *   → fixtures/demo-log.json
 */
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import type { AnalysisResult, LangCode } from '../src/contracts';
import { DEFAULT_ASSET_MANIFEST } from '../src/engine/assets/asset-manager';
import { decodeWav } from '../src/engine/audio/dsp';
import { DEMO_CATALOG } from '../src/engine/catalog/demo-catalog';
import { EngineCore } from '../src/engine/core';
import { analyzePcm } from '../src/engine/file-input';
import { DEMO_TASK } from '../src/engine/fixtures/demo-scenario';
import { OpusPivotTranslator, WhisperAsr } from '../src/engine/models/transformers-providers';
import { TaskLogRepository } from '../src/repositories/task-log-repository';

const FILES = ['demo-script1.wav', 'demo-script2.wav', 'demo-script3.wav'];
const LANGS: LangCode[] = ['en', 'id', 'vi'];

async function main() {
  const t0 = performance.now();
  const asrModel = DEFAULT_ASSET_MANIFEST.models.find((m) => m.role === 'asr')!;
  const asr = await WhisperAsr.create(asrModel, 'cpu' as never);
  const translator = await OpusPivotTranslator.create(DEFAULT_ASSET_MANIFEST.models.filter((m) => m.role === 'translation'), 'cpu' as never);
  console.error(`모델 준비 ${((performance.now() - t0) / 1000).toFixed(0)}s`);

  const repo = await TaskLogRepository.open(`demo-${Date.now()}`);
  const engine = new EngineCore({ repo, catalog: DEMO_CATALOG, asr, translator });
  const finals: AnalysisResult[] = [];
  engine.subscribe((e) => {
    if (e.type === 'analysis.final') finals.push((e.payload as { result: AnalysisResult }).result);
  });

  const { task } = await engine.saveTask(DEMO_TASK);
  for (const f of FILES) {
    const buf = fs.readFileSync(path.join('fixtures/audio/demo', f));
    const { pcm, sampleRate } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    await analyzePcm(engine, task.taskId, pcm, sampleRate, { fileName: f });
    await engine.whenIdle();
    console.error(`${f} 분석 완료`);
  }

  const latest = new Map<string, AnalysisResult>();
  for (const r of finals) if ((latest.get(r.utteranceId)?.revision ?? 0) < r.revision) latest.set(r.utteranceId, r);
  for (const r of latest.values()) {
    for (const lang of LANGS) await engine.requestTranslation(r.utteranceId, r.revision, lang);
  }

  const out = await engine.exportTaskLog(task.taskId, 'json');
  fs.writeFileSync('fixtures/demo-log.json', out.content);
  const log = await engine.getTaskLog(task.taskId);
  console.log(`\n일지: 발화 ${log.counts.utterances} · 차이 ${log.counts.differences} · 불명확 ${log.counts.ambiguous}  (총 ${((performance.now() - t0) / 1000).toFixed(0)}s)`);
  for (const e of log.utterances) {
    const r = e.results.at(-1)!;
    const en = e.translations.find((t) => t.targetLang === 'en' && t.sourceRevision === r.revision);
    console.log(`\n[${r.comparison.kind}] ${r.comparison.reasonCodes.join(',')}\n  E: ${r.enhancedTranscript?.text}\n  R: ${r.rawTranscript?.text}\n  요약(en): ${en?.summary?.oneLine ?? '-'}\n  참고(en): ${en?.text ?? '-'}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
