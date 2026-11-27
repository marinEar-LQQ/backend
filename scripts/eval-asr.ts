/**
 * 잡음 제거 엔진 평가 (백엔드 07장 "잡음 완화: 같은 원음에 대한 핵심 정보 인식 개선/악화").
 * 같은 녹음을 원음 / 우리 DSP / RNNoise 로 각각 처리 → 실제 엔진과 같은 WhisperAsr 로 인식 → 파일 단위 채점.
 *
 *   npx vite-node --config vitest.config.ts scripts/eval-asr.ts fixtures/audio/team/*.wav
 *
 * 채점 (정답: 같은 폴더 truth.json)
 *  - CER: 공백·문장부호 제거 후 글자 오류율 (낮을수록 좋음)
 *  - 핵심어: 선박명·호출부호·터미널·선석·침로·속력 등 대안 표기 중 하나라도 들어 있으면 적중
 *  - 터미널/선석: 엔진 추출기(extractCandidates)가 정답 집합과 같은 값을 뽑았는지
 * 브라우저와 같은 모델·양자화(q8)를 Node CPU 로 돌린다. 인식 시간은 브라우저 수치와 다르다.
 */
(globalThis as Record<string, unknown>).WorkerGlobalScope ??= function WorkerGlobalScope() {}; // RNNoise 웹 빌드 Node 우회
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_CATALOG } from '../src/engine/catalog/demo-catalog';
import { DEFAULT_ASSET_MANIFEST } from '../src/engine/assets/asset-manager';
import { decodeWav, encodeWav, resample } from '../src/engine/audio/dsp';
import { enhanceSpeech, type EnhanceOptions } from '../src/engine/audio/enhance';
import { rnnoiseDenoise } from '../src/engine/audio/rnnoise';
import { Segmenter } from '../src/engine/audio/segmenter';
import { extractCandidates } from '../src/engine/rules/extract';
import { WhisperAsr } from '../src/engine/models/transformers-providers';

type Variant = { name: string; run: (pcm: Float32Array) => Float32Array | Promise<Float32Array> };

const EXTRA: Array<[string, EnhanceOptions]> = [
  ['dsp-mild', { overSubtract: 1.0, gainFloor: 0.3 }],
  ['dsp-strong', { overSubtract: 2.0, gainFloor: 0.05 }],
  ['band-only', { overSubtract: 0, gainFloor: 1 }],
];
const ALL: Variant[] = [
  { name: 'raw', run: (p) => p },
  { name: 'dsp', run: (p) => enhanceSpeech(p, 16000) },
  { name: 'rnnoise', run: async (p) => (await rnnoiseDenoise(p, 16000)).pcm },
  ...EXTRA.map(([name, o]): Variant => ({ name, run: (p) => enhanceSpeech(p, 16000, o) })),
];
const pick = (process.env.VARIANTS ?? 'raw,dsp,rnnoise').split(',');
const VARIANTS = ALL.filter((v) => pick.includes(v.name));

interface FileTruth {
  text: string;
  keyterms: string[][];
  terminals: string[];
  berths: string[];
}

const norm = (s: string) => s.toUpperCase().replace(/[\s.,?!…\-'"·:;()[\]]/g, '');

function cer(hyp: string, ref: string): number {
  const a = Array.from(norm(hyp));
  const b = Array.from(norm(ref));
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]! / Math.max(1, b.length);
}

function extracted(text: string, field: 'terminal' | 'berth'): string[] {
  const ex = extractCandidates({ text, segments: [], modelVersion: null, wordAligned: false }, 'raw', DEMO_CATALOG);
  return [...new Set(ex.candidates.filter((c) => c.field === field).map((c) => c.value))].sort();
}

async function main() {
  const files = process.argv.slice(2).filter((a) => a.endsWith('.wav'));
  if (!files.length) throw new Error('wav 파일을 인자로 주세요');
  const dir = path.dirname(files[0]!);
  const truth: Record<string, FileTruth> = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'));
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir, { recursive: true });

  const model = { ...DEFAULT_ASSET_MANIFEST.models.find((m) => m.role === 'asr')!, ...(process.env.ASR_MODEL ? { modelId: process.env.ASR_MODEL } : {}) };
  console.error(`모델 로딩: ${model.modelId}`);
  const asr = await WhisperAsr.create(model, 'cpu' as never);

  const report: string[] = [];
  const table: Array<Record<string, string | number>> = [];

  for (const file of files) {
    const base = path.basename(file);
    const t = truth[base];
    const buf = fs.readFileSync(file);
    const { pcm, sampleRate } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const seg = new Segmenter();
    const step = Math.round(sampleRate * 0.1);
    const utts = [];
    for (let i = 0, seq = 0; i < pcm.length; i += step, seq++) {
      utts.push(...seg.push({ sessionId: 'eval', seq, startMs: Math.round((i / sampleRate) * 1000), sampleRate, channels: 1, pcm: pcm.slice(i, i + step) }).utterances);
    }
    utts.push(...seg.flush());
    report.push(`\n## ${base} — 발화 ${utts.length}개: ${utts.map((u) => `${(u.startMs / 1000).toFixed(1)}–${(u.endMs / 1000).toFixed(1)}s`).join(', ')}`);

    for (const v of VARIANTS) {
      const texts: string[] = [];
      let ms = 0;
      let audioMs = 0;
      for (const [ui, u] of utts.entries()) {
        const p16 = resample(u.pcm, u.sampleRate, 16000);
        const audio = await v.run(p16);
        if (v.name !== 'raw') fs.writeFileSync(path.join(outDir, `${base.replace('.wav', '')}-${ui + 1}-${v.name}.wav`), Buffer.from(encodeWav(audio, 16000)));
        const t0 = performance.now();
        const tr = await asr.transcribe(audio, { utteranceId: `u${ui}`, sessionId: 'eval', utteranceIndex: ui, variant: 'raw', utteranceStartMs: u.startMs });
        ms += performance.now() - t0;
        audioMs += u.endMs - u.startMs;
        texts.push(tr.text);
      }
      const hyp = texts.join(' ');
      const row: Record<string, string | number> = { file: base, variant: v.name, rtf: +(ms / audioMs).toFixed(2) };
      if (t) {
        const hn = norm(hyp);
        const hits = t.keyterms.filter((alts) => alts.some((a) => hn.includes(norm(a))));
        const term = extracted(hyp, 'terminal');
        const berth = extracted(hyp, 'berth');
        row.cer = +(cer(hyp, t.text) * 100).toFixed(1);
        row.keyterms = `${hits.length}/${t.keyterms.length}`;
        row.terminals = `${term.join(',') || '-'} (정답 ${t.terminals.join(',') || '-'})`;
        row.berths = `${berth.join(',') || '-'} (정답 ${t.berths.join(',') || '-'})`;
        row.miss = t.keyterms.filter((alts) => !hits.includes(alts)).map((a) => a[0]).join(' ');
      }
      table.push(row);
      report.push(`- [${v.name}] ${hyp}`);
      console.error(`${base} ${v.name} 완료`);
    }
  }

  console.log(report.join('\n'));
  console.log('\n## 요약 (CER 낮을수록, 핵심어 높을수록 좋음)');
  for (const r of table) console.log(Object.entries(r).map(([k, v]) => `${k}=${v}`).join(' | '));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
