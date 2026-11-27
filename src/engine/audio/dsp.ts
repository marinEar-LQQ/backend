/** 기본 신호 처리: 리샘플링, FFT, biquad 필터, WAV 인코딩. 외부 의존성 없음. */

// ───────── 리샘플링 (windowed-sinc) ─────────

/**
 * 원본 sampleRate 의 PCM 을 모델 규격(예: 16 kHz)으로 변환한다. 원본은 바꾸지 않는다.
 * 다운샘플 시 앨리어싱 방지를 위해 cutoff 를 목표 나이퀴스트 아래로 둔다.
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input.slice();
  const ratio = to / from;
  const outLen = Math.floor(input.length * ratio);
  const out = new Float32Array(outLen);
  const cutoff = Math.min(1, ratio) * 0.95; // 입력 나이퀴스트 대비
  const half = Math.ceil(8 / cutoff);
  for (let i = 0; i < outLen; i++) {
    const center = i / ratio;
    const c0 = Math.floor(center);
    let sum = 0;
    let wsum = 0;
    for (let j = c0 - half + 1; j <= c0 + half; j++) {
      if (j < 0 || j >= input.length) continue;
      const x = j - center;
      const px = Math.PI * cutoff * x;
      const sinc = x === 0 ? 1 : Math.sin(px) / px;
      const win = 0.5 + 0.5 * Math.cos((Math.PI * x) / half); // Hann
      const w = sinc * win;
      sum += input[j]! * w;
      wsum += w;
    }
    out[i] = wsum !== 0 ? sum / wsum : 0;
  }
  return out;
}

// ───────── FFT (radix-2, in-place) ─────────

export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! / n;
      im[i] = im[i]! / n;
    }
  }
}

// ───────── Biquad (RBJ cookbook) ─────────

export function biquad(input: Float32Array, sampleRate: number, type: 'highpass' | 'lowpass', freq: number, q = Math.SQRT1_2): Float32Array {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i]!;
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

// ───────── 측정 ─────────

export function rms(pcm: Float32Array, start = 0, end = pcm.length): number {
  let s = 0;
  for (let i = start; i < end; i++) s += pcm[i]! * pcm[i]!;
  return end > start ? Math.sqrt(s / (end - start)) : 0;
}

export function peak(pcm: Float32Array): number {
  let p = 0;
  for (let i = 0; i < pcm.length; i++) p = Math.max(p, Math.abs(pcm[i]!));
  return p;
}

export function concat(chunks: Float32Array[]): Float32Array {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// ───────── WAV ─────────

/** 16-bit PCM mono WAV */
export function encodeWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

export function decodeWav(buf: ArrayBuffer): { pcm: Float32Array; sampleRate: number } {
  const v = new DataView(buf);
  const sampleRate = v.getUint32(24, true);
  const channels = v.getUint16(22, true);
  let offset = 12;
  while (offset < v.byteLength - 8) {
    const id = String.fromCharCode(v.getUint8(offset), v.getUint8(offset + 1), v.getUint8(offset + 2), v.getUint8(offset + 3));
    const size = v.getUint32(offset + 4, true);
    if (id === 'data') {
      const n = Math.floor(size / 2 / channels);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = v.getInt16(offset + 8 + i * 2 * channels, true) / 0x8000;
      return { pcm, sampleRate };
    }
    offset += 8 + size;
  }
  throw new Error('WAV data chunk 없음');
}

export async function sha256Hex(data: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const hash = await subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}
