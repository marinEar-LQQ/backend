/**
 * Cleanvoice 잡음 제거 (REST v2) — 중계 서버와 평가 스크립트에서만 사용 (키 노출 금지).
 * 흐름: POST /v2/upload?filename → PUT signedUrl → POST /v2/edits → GET /v2/edits/{id} 폴링 → result.download_url
 * 길이·타이밍을 바꾸는 편집(필러·침묵 제거 등)은 모두 끄고, 혹시 걸려도 자르지 말고 무음 처리(muted)한다.
 */

const BASE = 'https://api.cleanvoice.ai/v2';

export interface CleanvoiceOptions {
  apiKey: string;
  /** studio_sound: 더 강한 처리 (문서상 remove_noise 보다 강함) */
  studio?: boolean;
  /** 폴링 최대 대기 (기본 180초) */
  timeoutMs?: number;
  onStatus?: (status: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function check(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  const body = await res.text().catch(() => '');
  throw new Error(`Cleanvoice ${what} ${res.status}: ${body.slice(0, 300)}`);
}

export async function cleanvoiceDenoise(opts: CleanvoiceOptions, wav: Uint8Array, filename = 'clip.wav'): Promise<Uint8Array> {
  const auth = { 'X-API-Key': opts.apiKey };

  // 1) 업로드용 서명 URL
  const up = (await (await check(await fetch(`${BASE}/upload?filename=${encodeURIComponent(filename)}`, { method: 'POST', headers: auth }), 'upload')).json()) as { signedUrl?: string };
  if (!up.signedUrl) throw new Error('Cleanvoice upload: signedUrl 없음');
  await check(await fetch(up.signedUrl, { method: 'PUT', headers: { 'Content-Type': 'audio/wav' }, body: wav }), 'PUT');
  const fileUrl = up.signedUrl.split('?')[0]!;

  // 2) 작업 생성 — 잡음 제거만, 타이밍 보존
  const config = {
    remove_noise: true,
    ...(opts.studio ? { studio_sound: true } : {}),
    normalize: true,
    export_format: 'wav',
    muted: true,
    fillers: false,
    long_silences: false,
    mouth_sounds: false,
    stutters: false,
    hesitations: false,
    breath: false,
  };
  const edit = (await (
    await check(await fetch(`${BASE}/edits`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ input: { files: [fileUrl], config } }) }), 'edits')
  ).json()) as { id?: string };
  if (!edit.id) throw new Error('Cleanvoice edits: id 없음');

  // 3) 폴링 (문서 권장보다 촘촘하게: 짧은 클립용. 처음 5초 대기 후 3초 간격)
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  await sleep(5000);
  for (;;) {
    const st = (await (await check(await fetch(`${BASE}/edits/${edit.id}`, { headers: auth }), 'retrieve')).json()) as {
      status?: string;
      result?: { download_url?: string };
    };
    opts.onStatus?.(st.status ?? '?');
    if (st.status === 'SUCCESS') {
      const url = st.result?.download_url;
      if (!url) throw new Error('Cleanvoice: download_url 없음');
      const audio = await check(await fetch(url), 'download');
      // 처리 끝난 파일은 바로 삭제 (원음을 외부에 오래 두지 않는다)
      void fetch(`${BASE}/edits/${edit.id}`, { method: 'DELETE', headers: auth }).catch(() => undefined);
      return new Uint8Array(await audio.arrayBuffer());
    }
    if (st.status === 'FAILURE') throw new Error('Cleanvoice 처리 실패 (FAILURE)');
    if (Date.now() > deadline) throw new Error('Cleanvoice 처리 시간 초과');
    await sleep(3000);
  }
}
