import fs from 'node:fs';
import { decodeWav, rms } from '../src/engine/audio/dsp';
import { Segmenter, type SegmenterOptions } from '../src/engine/audio/segmenter';
const files = process.argv.slice(2);
const configs: Array<[string, Partial<SegmenterOptions>]> = [['기본값', {}]];
for (const f of files) {
  const b = fs.readFileSync(f); const { pcm, sampleRate: sr } = decodeWav(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  // 100ms 단위 rms 윤곽 (dB)
  const prof: string[] = []; for (let i = 0; i + sr / 10 <= pcm.length; i += sr / 10) prof.push((20 * Math.log10(rms(pcm, i, i + sr / 10) + 1e-6)).toFixed(0));
  console.log(`\n${f.split('/').pop()} rms(dB/100ms) min ${Math.min(...prof.map(Number))} max ${Math.max(...prof.map(Number))} p20 ${prof.map(Number).sort((a,b)=>a-b)[Math.floor(prof.length*0.2)]}`);
  for (const [name, o] of configs) {
    const s = new Segmenter(o); const u = [];
    for (let i = 0, q = 0; i < pcm.length; i += sr / 10, q++) u.push(...s.push({ sessionId: 's', seq: q, startMs: (i / sr) * 1000, sampleRate: sr, channels: 1, pcm: pcm.slice(i, i + sr / 10) }).utterances);
    u.push(...s.flush());
    console.log(`  ${name.padEnd(16)} ${u.length}개: ${u.map((x) => `${(x.startMs / 1000).toFixed(1)}-${(x.endMs / 1000).toFixed(1)}${x.flags.includes('TRUNCATED') ? '✂' : ''}`).join(' ')}`);
  }
}
