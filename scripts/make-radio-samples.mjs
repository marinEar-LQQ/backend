// TTS 음성에 무전 잡음(광대역 잡음 + 험 + 약한 클리핑)을 섞고, 시나리오 전체를 한 파일로 이어 붙인다.
// 합성 잡음 파일이므로 현장 성능 근거로 쓰지 않는다 (백엔드 07장).
import fs from 'node:fs';
const dir = process.argv[2] ?? 'fixtures/audio';
const order = ['case-a', 'case-b', 'case-c', 'case-d', 'case-match', 'case-correction'];
function readWav(p) {
  const b = fs.readFileSync(p); const sr = b.readUInt32LE(24); let o = 12;
  while (o < b.length - 8) { const id = b.toString('ascii', o, o + 4); const sz = b.readUInt32LE(o + 4);
    if (id === 'data') { const n = sz / 2; const pcm = new Float32Array(n); for (let i = 0; i < n; i++) pcm[i] = b.readInt16LE(o + 8 + i * 2) / 32768; return { pcm, sr }; }
    o += 8 + sz; }
  throw new Error('no data');
}
function writeWav(p, pcm, sr) {
  const b = Buffer.alloc(44 + pcm.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + pcm.length * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
  fs.writeFileSync(p, b);
}
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
function radioize(pcm, sr, noiseAmp) {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const hum = 0.02 * Math.sin(2 * Math.PI * 60 * i / sr);
    let v = pcm[i] * 1.6 + noiseAmp * rnd() + hum;
    out[i] = Math.max(-0.95, Math.min(0.95, v));
  }
  return out;
}
const sr = 16000; const gap = new Float32Array(sr * 1.5);
const parts = [];
for (const k of order) {
  const { pcm } = readWav(`${dir}/tts-${k}.wav`);
  const noisy = radioize(pcm, sr, 0.08);
  writeWav(`${dir}/radio-${k}.wav`, noisy, sr);
  parts.push(gap, pcm);
}
parts.push(gap);
const len = parts.reduce((n, p) => n + p.length, 0); const all = new Float32Array(len); let o = 0;
for (const p of parts) { all.set(p, o); o += p.length; }
writeWav(`${dir}/scenario-clean.wav`, all, sr);
writeWav(`${dir}/scenario-radio.wav`, radioize(all, sr, 0.08), sr);
console.log('ok', (len / sr).toFixed(1) + 's');
