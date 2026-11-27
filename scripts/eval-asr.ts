/**
 * 잡음 제거 엔진 평가 (백엔드 07장 "잡음 완화: 같은 원음에 대한 핵심 정보 인식 개선/악화").
 * 같은 발화를 원음 / 완화음(설정별)으로 Whisper 인식 → 핵심 정보(선박·터미널·선석) 정답률 비교.
 *
 *   npx vite-node scripts/eval-asr.ts -- fixtures/audio/team/*.wav
 *   (정답: fixtures/audio/team/truth.json — 없으면 인식 결과만 출력)
 *
 * 브라우저와 같은 모델·양자화(q8)를 Node CPU 로 돌린다. 속도 수치는 브라우저와 다르다.
 */
(globalThis as any).WorkerGlobalScope ??= function WorkerGlobalScope() {}; // RNNoise 웹 빌드를 Node 에서 쓰기 위한 우회
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_CATALOG } from '../src/engine/catalog/demo-catalog';
import { decodeWav, encodeWav, resample } from '../src/engine/audio/dsp';
import { enhanceSpeech, type EnhanceOptions } from '../src/engine/audio/enhance';
import { rnnoiseDenoise } from '../src/engine/audio/rnnoise';
import { Segmenter } from '../src/engine/audio/segmenter';
import { extractCandidates } from '../src/engine/rules/extract';
import { cleanTranscript } from '../src/engine/models/transformers-providers';

type Variant = { name: string; run: (pcm: Float32Array) => Float32Array | Promise<Float32Array> };

const VARIANTS: Variant[] = [
  { name: 'raw', run: (p) => p },
  { name: 'enh-default', run: (p) => enhanceSpeech(p, 16000) },
  { name: 'rnnoise', run: async (p) => (await rnnoiseDenoise(p, 16000)).pcm },
  { name: 'rnnoise+band', run: async (p) => enhanceSpeech((await rnnoiseDenoise(p, 16000)).pcm, 16000, { overSubtract: 0, gainFloor: 1 }) },
  ...(process.env.VARIANTS === 'all'
    ? ([
        ['enh-mild', { overSubtract: 1.0, gainFloor: 0.3 }],
        ['enh-strong', { overSubtract: 2.0, gainFloor: 0.05 }],
        ['enh-wideband', { lowHz: 150, highHz: 4000 }],
        ['enh-p10', { noisePercentile: 0.1 }],
      ] as Array<[string, EnhanceOptions]>).map(([name, o]) => ({ name, run: (p: Float32Array) => enhanceSpeech(p, 16000, o) }))
    : []),
];

interface Truth {
  /** 파일명 → 발화 순서대로 정답 문장 (모르면 null) */
  [file: string]: Array<string | null>;
}

function keyInfo(text: string, known: string[]) {
  const ex = extractCandidates({ text, segments: [], modelVersion: null, wordAligned: false }, 'raw', DEMO_CATALOG, known);
  const pick = (f: string) => [...new Set(ex.candidates.filter((c) => c.field === f && !c.negated).map((c) => c.value))].sort().join('|');
  return { vessel: pick('vessel'), terminal: pick('terminal'), berth: pick('berth') };
}

async function main() {
  const files = process.argv.slice(2).filter((a) => a.endsWith('.wav'));
  if (!files.length) throw new Error('wav 파일을 인자로 주세요');
  const truthPath = path.join(path.dirname(files[0]!), 'truth.json');
  const truth: Truth = fs.existsSync(truthPath) ? JSON.parse(fs.readFileSync(truthPath, 'utf8')) : {};
  const outDir = path.join(path.dirname(files[0]!), 'out');
  fs.mkdirSync(outDir, { recursive: true });

  const { pipeline } = await import('@huggingface/transformers');
  const model = process.env.ASR_MODEL ?? 'onnx-community/whisper-small';
  console.error(`모델 로딩: ${model}`);
  const asr = (await pipeline('automatic-speech-recognition', model, { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } as never })) as unknown as (
    a: Float32Array,
    o: object,
  ) => Promise<{ text: string }>;

  const known = ['해동호', 'A선박', 'B선박'];
  const score: Record<string, { n: number; vessel: number; terminal: number; berth: number; ms: number }> = {};
  const rows: string[] = [];

  for (const file of files) {
    const base = path.basename(file);
    const buf = fs.readFileSync(file);
    const { pcm, sampleRate } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const seg = new Segmenter();
    const step = Math.round(sampleRate * 0.1);
    const utts = [];
    for (let i = 0, seq = 0; i < pcm.length; i += step, seq++) {
      utts.push(...seg.push({ sessionId: 'eval', seq, startMs: Math.round((i / sampleRate) * 1000), sampleRate, channels: 1, pcm: pcm.slice(i, i + step) }).utterances);
    }
    utts.push(...seg.flush());
    console.error(`${base}: 발화 ${utts.length}개`);

    for (const [ui, u] of utts.entries()) {
      const p16 = resample(u.pcm, u.sampleRate, 16000);
      const gold = truth[base]?.[ui] ?? null;
      const goldKey = gold ? keyInfo(gold, known) : null;
      rows.push(`\n## ${base} #${ui + 1} (${(u.startMs / 1000).toFixed(1)}–${(u.endMs / 1000).toFixed(1)}s)${gold ? `\n정답: ${gold}` : ''}`);
      for (const v of VARIANTS) {
        const audio = await v.run(p16);
        if (v.name !== 'raw' && ui < 3) fs.writeFileSync(path.join(outDir, `${base.replace('.wav', '')}-${ui + 1}-${v.name}.wav`), Buffer.from(encodeWav(audio, 16000)));
        const t0 = performance.now();
        const out = await asr(audio, { language: 'korean', task: 'transcribe' });
        const ms = performance.now() - t0;
        const text = cleanTranscript(out.text);
        const k = keyInfo(text, known);
        const s = (score[v.name] ??= { n: 0, vessel: 0, terminal: 0, berth: 0, ms: 0 });
        s.ms += ms;
        let mark = '';
        if (goldKey) {
          s.n++;
          const ok = (f: 'vessel' | 'terminal' | 'berth') => (k[f] === goldKey[f] ? (s[f]++, '✓') : '✗');
          mark = ` [선박${ok('vessel')} 터미널${ok('terminal')} 선석${ok('berth')}]`;
        }
        rows.push(`- ${v.name.padEnd(12)} ${text}${mark}  (${(ms / 1000).toFixed(1)}s)`);
      }
    }
  }

  console.log(rows.join('\n'));
  console.log('\n## 요약 (핵심 정보 정답 수 / 정답 있는 발화 수)');
  for (const [name, s] of Object.entries(score)) {
    console.log(`${name.padEnd(12)} 선박 ${s.vessel}/${s.n}  터미널 ${s.terminal}/${s.n}  선석 ${s.berth}/${s.n}  인식시간 합 ${(s.ms / 1000).toFixed(1)}s`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
