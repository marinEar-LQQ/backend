// 시연용 녹음: 대본 대사별 TTS 를 이어 붙이고 약한 무전 잡음(광대역 0.015 + 60Hz 험)을 섞는다.
// 팀 원본(script*_noisy)보다 잡음이 약하다. 합성 음성이므로 현장 성능 근거로 쓰지 않는다.
import fs from 'node:fs';
const dir = 'fixtures/audio/demo';
const read = (p) => { const b = fs.readFileSync(p); let o = 12; while (o < b.length - 8) { const id = b.toString('ascii', o, o + 4), sz = b.readUInt32LE(o + 4); if (id === 'data') { const n = sz / 2, x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = b.readInt16LE(o + 8 + i * 2) / 32768; return x; } o += 8 + sz; } };
const write = (p, x, sr = 16000) => { const b = Buffer.alloc(44 + x.length * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(x.length * 2, 40); for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2); fs.writeFileSync(p, b); };
let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
for (const s of ['1', '2', '3']) {
  const parts = [new Float32Array(16000)];
  for (const t of ['1', '2', '3']) parts.push(read(`${dir}/parts/${s}-${t}.wav`), new Float32Array(19200));
  const len = parts.reduce((n, p) => n + p.length, 0), x = new Float32Array(len); let o = 0;
  for (const p of parts) { x.set(p, o); o += p.length; }
  for (let i = 0; i < x.length; i++) x[i] = Math.max(-0.95, Math.min(0.95, x[i] * 1.4 + 0.015 * rnd() + 0.008 * Math.sin(2 * Math.PI * 60 * i / 16000)));
  write(`${dir}/demo-script${s}.wav`, x);
  console.log(`demo-script${s}.wav ${(len / 16000).toFixed(1)}s`);
}
