import { EngineError, type AssetManifest, type LangCode, type LoadProgress, type Transcript } from '../../contracts';
import { encodeWav } from '../audio/dsp';
import { cleanTranscript } from '../models/transformers-providers';
import type { AsrContext, AsrProvider, AssetLoader, AssetState, TranslationProvider } from '../providers';

/**
 * 온라인 모드 부품: 중계 서버(server/index.ts)를 통해 클라우드 전사·번역을 쓴다.
 * 브라우저에는 API 키가 없다 — 중계 서버 주소(proxyUrl)만 안다.
 * 발화 자르기·판정 규칙·저장은 오프라인과 같은 엔진 코드를 그대로 쓴다.
 */

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function post<T>(proxyUrl: string, path: string, body: unknown, timeoutMs: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${proxyUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new EngineError('ONLINE_UNAVAILABLE', `온라인 분석 서버에 연결할 수 없습니다. 인터넷과 중계 서버를 확인하세요. (${String((e as Error)?.message ?? e)})`, true);
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new EngineError('ONLINE_UNAVAILABLE', `온라인 분석 실패 (${res.status}): ${json.error ?? ''}`, true, { status: res.status });
  return json;
}

export class OnlineAsr implements AsrProvider {
  readonly sampleRate = 16000 as const;
  modelVersion = 'online-asr';

  constructor(
    private readonly proxyUrl: string,
    /** 용어 힌트 (카탈로그 터미널 코드). 들린 경우에만 쓰도록 서버 지시문에 명시되어 있다 */
    private readonly hints: string[],
  ) {}

  async transcribe(pcm16k: Float32Array, ctx: AsrContext): Promise<Transcript> {
    const out = await post<{ text: string; model: string }>(this.proxyUrl, '/api/transcribe', { wavBase64: toBase64(encodeWav(pcm16k, 16000)), hints: [...new Set([...(ctx.vocabulary ?? []), ...this.hints])] }, 60000);
    this.modelVersion = `online:${out.model}`;
    const text = cleanTranscript(out.text ?? '');
    const endMs = ctx.utteranceStartMs + Math.round((pcm16k.length / 16000) * 1000);
    return {
      text,
      segments: text ? [{ segmentId: `${ctx.utteranceId}-${ctx.variant}-0`, text, startMs: ctx.utteranceStartMs, endMs, confidence: null }] : [],
      modelVersion: this.modelVersion,
      wordAligned: false,
    };
  }
}

export class OnlineTranslator implements TranslationProvider {
  modelVersion = 'online-translate';
  /** placeholder 방식: 큰 모델은 [1] 자리표시를 지키므로 복원·검증까지 한다 */
  readonly mode = 'placeholder' as const;

  constructor(private readonly proxyUrl: string) {}

  supports(target: LangCode): boolean {
    return target === 'en' || target === 'id' || target === 'vi';
  }

  async translate(text: string, target: LangCode): Promise<string> {
    const out = await post<{ text: string; model: string }>(this.proxyUrl, '/api/translate', { text, target }, 60000);
    this.modelVersion = `online:${out.model}`;
    return out.text;
  }
}

/** 온라인 모드의 "자원 준비" = 중계 서버 상태 확인. 내려받을 모델이 없다 */
export class OnlineAssets implements AssetLoader {
  private readonly asrProvider: OnlineAsr;
  private readonly translationProvider: OnlineTranslator;
  private health: { asr: boolean; translate: boolean } | null = null;

  constructor(
    private readonly proxyUrl: string,
    hints: string[],
  ) {
    this.asrProvider = new OnlineAsr(proxyUrl, hints);
    this.translationProvider = new OnlineTranslator(proxyUrl);
  }

  async load(_manifest: AssetManifest, _onProgress?: (p: LoadProgress) => void): Promise<void> {
    await this.check();
    if (!this.health?.asr) throw new EngineError('ONLINE_UNAVAILABLE', '중계 서버에 음성인식 키가 설정되지 않았습니다.', true);
  }

  async check(): Promise<{ asr: boolean; translate: boolean }> {
    try {
      const res = await fetch(`${this.proxyUrl}/api/health`, { signal: AbortSignal.timeout(8000) });
      this.health = (await res.json()) as { asr: boolean; translate: boolean };
    } catch (e) {
      this.health = null;
      throw new EngineError('ONLINE_UNAVAILABLE', `온라인 분석 서버에 연결할 수 없습니다. (${String((e as Error)?.message ?? e)})`, true);
    }
    return this.health;
  }

  states(): AssetState[] {
    return [];
  }

  asr(): AsrProvider {
    return this.asrProvider;
  }

  translator(): TranslationProvider | null {
    return this.health && !this.health.translate ? null : this.translationProvider;
  }
}
