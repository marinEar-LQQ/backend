/**
 * marinEar 중계 서버 — API 키를 브라우저에 노출하지 않기 위한 얇은 프록시.
 *   npm run server   (기본 http://localhost:8787, 키는 저장소 루트 .env)
 *
 *   GET  /api/health                       → { asr, translate, models }
 *   POST /api/transcribe { wavBase64, hints } → { text, model }      (Gemini)
 *   POST /api/translate  { text, target }    → { text, model }      (NVIDIA NIM)
 *
 * 음성은 분석을 위해 외부 서비스로 전송된다. 서버는 음성·자막을 저장하지 않는다.
 */
import fs from 'node:fs';
import http from 'node:http';
import { geminiTranscribe } from '../src/online/gemini';
import { nvidiaTranslate } from '../src/online/nvidia';

function loadEnv(): Record<string, string> {
  if (!fs.existsSync('.env')) return {};
  return Object.fromEntries(
    fs.readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );
}

const env = { ...loadEnv(), ...process.env } as Record<string, string | undefined>;
const PORT = Number(env.PORT ?? 8787);
const ASR_MODEL = env.ASR_MODEL ?? 'gemini-3.5-flash-lite';
const MT_MODEL = env.MT_MODEL ?? 'nvidia/nemotron-3-ultra-550b-a55b';
const MAX_BODY = 12 * 1024 * 1024; // 28초 16kHz WAV base64 ≈ 1.2MB. 여유 있게 12MB

/** 로컬 개발 주소만 허용 (시연용). 배포 시 프론트 주소를 ALLOWED_ORIGINS 에 추가 */
const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
function originOk(origin: string | undefined): boolean {
  if (!origin) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin) || allowed.includes(origin);
}

function send(res: http.ServerResponse, status: number, body: unknown, origin?: string): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cross-origin-resource-policy': 'cross-origin',
    vary: 'origin',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error('요청이 너무 큽니다'), { status: 413 });
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (!originOk(origin)) return send(res, 403, { error: '허용되지 않은 출처' });
  if (req.method === 'OPTIONS') return send(res, 200, {}, origin);
  const path = (req.url ?? '').split('?')[0];
  const started = Date.now();
  try {
    if (req.method === 'GET' && path === '/api/health') {
      return send(res, 200, { asr: !!env.GEMINI_API_KEY, translate: !!env.NVIDIA_API_KEY, models: { asr: ASR_MODEL, translate: MT_MODEL } }, origin);
    }
    if (req.method === 'POST' && path === '/api/transcribe') {
      if (!env.GEMINI_API_KEY) return send(res, 503, { error: 'GEMINI_API_KEY 가 설정되지 않았습니다' }, origin);
      const body = await readJson(req);
      if (typeof body.wavBase64 !== 'string' || !body.wavBase64) return send(res, 400, { error: 'wavBase64 필요' }, origin);
      const hints = Array.isArray(body.hints) ? body.hints.filter((h): h is string => typeof h === 'string').slice(0, 50) : [];
      const text = await geminiTranscribe({ apiKey: env.GEMINI_API_KEY, model: ASR_MODEL }, body.wavBase64, hints);
      console.log(`transcribe ${Date.now() - started}ms`);
      return send(res, 200, { text, model: ASR_MODEL }, origin);
    }
    if (req.method === 'POST' && path === '/api/translate') {
      if (!env.NVIDIA_API_KEY) return send(res, 503, { error: 'NVIDIA_API_KEY 가 설정되지 않았습니다' }, origin);
      const body = await readJson(req);
      if (typeof body.text !== 'string' || typeof body.target !== 'string') return send(res, 400, { error: 'text, target 필요' }, origin);
      if (!['en', 'id', 'vi'].includes(body.target)) return send(res, 400, { error: '지원하지 않는 언어' }, origin);
      const text = await nvidiaTranslate({ apiKey: env.NVIDIA_API_KEY, model: MT_MODEL }, body.text.slice(0, 4000), body.target);
      console.log(`translate(${body.target}) ${Date.now() - started}ms`);
      return send(res, 200, { text, model: MT_MODEL }, origin);
    }
    return send(res, 404, { error: 'not found' }, origin);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 502;
    console.error(`${path} 실패:`, (e as Error).message.slice(0, 200));
    return send(res, status, { error: (e as Error).message.slice(0, 300) }, origin);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`marinEar 중계 서버 http://localhost:${PORT}  (전사 ${env.GEMINI_API_KEY ? ASR_MODEL : '키 없음'} / 번역 ${env.NVIDIA_API_KEY ? MT_MODEL : '키 없음'})`);
});
