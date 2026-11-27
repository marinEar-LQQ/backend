import { EngineError, type AssetManifest, type AssetStatus, type LoadProgress, type ModelManifest } from '../../contracts';
import { DEMO_CATALOG } from '../catalog/demo-catalog';
import type { AsrProvider, AssetLoader, AssetState, TranslationProvider } from '../providers';
import { M2M100Translator, WhisperAsr, configureRuntime, pickDevice, type Device } from '../models/transformers-providers';

/**
 * 기본 자원 manifest. 라이선스·용량·입력 규격·지원 언어를 기록한다 (백엔드 01장).
 * sha256 이 null 이면 첫 설치 시 계산한 값을 기록(pin)하고, 이후 불일치하면 MODEL_INTEGRITY.
 */
export const DEFAULT_ASSET_MANIFEST: AssetManifest = {
  manifestVersion: '2026.11.27-1',
  catalog: DEMO_CATALOG,
  models: [
    {
      modelId: 'onnx-community/whisper-small',
      version: 'main',
      sha256: null,
      bytes: null,
      role: 'asr',
      inputSpec: { sampleRate: 16000, channels: 1, maxSeconds: 30 },
      languages: ['ko'],
      license: 'Apache-2.0 (ONNX export) / MIT (OpenAI Whisper weights)',
      runtimeVersion: '@huggingface/transformers@4.3.2',
    },
    {
      modelId: 'Xenova/m2m100_418M',
      version: 'main',
      sha256: null,
      bytes: null,
      role: 'translation',
      inputSpec: null,
      languages: ['ko', 'my', 'id', 'en', 'vi', 'fil'],
      license: 'MIT (facebook/m2m100_418M)',
      runtimeVersion: '@huggingface/transformers@4.3.2',
      langPairs: [
        ['ko', 'my'],
        ['ko', 'id'],
        ['ko', 'en'],
        ['ko', 'vi'],
        ['ko', 'fil'],
      ],
    },
  ],
};

export interface AssetManagerOptions {
  /** 첫 설치·업데이트 때만 true. 현장(오프라인) 검증 시 false */
  allowRemote: boolean;
  device?: Device;
  localModelPath?: string;
  /** 번역 모델을 건너뛸지 (저사양 기기) */
  skipTranslation?: boolean;
}

/** Cache Storage 에 저장된 모델 파일들의 해시를 합친 값 (파일명 정렬 후 "이름:해시" 를 다시 해시) */
async function cachedModelDigest(modelId: string): Promise<{ digest: string | null; bytes: number }> {
  if (typeof caches === 'undefined' || !globalThis.crypto?.subtle) return { digest: null, bytes: 0 };
  const names = await caches.keys();
  const parts: string[] = [];
  let bytes = 0;
  for (const name of names) {
    const cache = await caches.open(name);
    for (const req of await cache.keys()) {
      if (!req.url.includes(modelId)) continue;
      const res = await cache.match(req);
      if (!res) continue;
      const buf = await res.arrayBuffer();
      bytes += buf.byteLength;
      const h = await crypto.subtle.digest('SHA-256', buf);
      parts.push(`${req.url.split(modelId)[1]}:${Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('')}`);
    }
  }
  if (parts.length === 0) return { digest: null, bytes };
  parts.sort();
  const all = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\n')));
  return { digest: Array.from(new Uint8Array(all), (b) => b.toString(16).padStart(2, '0')).join(''), bytes };
}

export class AssetManager implements AssetLoader {
  private readonly state = new Map<string, AssetState>();
  private asrProvider: AsrProvider | null = null;
  private translationProvider: TranslationProvider | null = null;
  /** 첫 설치 때 계산한 해시 (manifest 에 반영해 고정하는 용도) */
  readonly computedDigests = new Map<string, { sha256: string | null; bytes: number }>();

  constructor(private readonly opts: AssetManagerOptions) {}

  states(): AssetState[] {
    return [...this.state.values()];
  }

  asr(): AsrProvider | null {
    return this.asrProvider;
  }

  translator(): TranslationProvider | null {
    return this.translationProvider;
  }

  private set(model: ModelManifest, status: AssetStatus, selfTest: AssetState['selfTest'] = 'not_run'): void {
    this.state.set(model.modelId, { model, status, selfTest });
  }

  async load(manifest: AssetManifest, onProgress?: (p: LoadProgress) => void): Promise<void> {
    await configureRuntime({ allowRemote: this.opts.allowRemote, ...(this.opts.localModelPath ? { localModelPath: this.opts.localModelPath } : {}) });
    const device = this.opts.device ?? (await pickDevice());
    const failures: string[] = [];

    for (const model of manifest.models) {
      if (model.role === 'translation' && this.opts.skipTranslation) continue;
      this.set(model, 'downloading');
      try {
        if (model.role === 'asr') {
          this.asrProvider = await WhisperAsr.create(model, device, onProgress);
        } else if (model.role === 'translation') {
          this.translationProvider = await M2M100Translator.create(model, device, onProgress);
        } else {
          continue;
        }

        // 무결성 검사
        this.set(model, 'verifying');
        const { digest, bytes } = await cachedModelDigest(model.modelId);
        this.computedDigests.set(model.modelId, { sha256: digest, bytes });
        if (model.sha256 && digest && model.sha256 !== digest) {
          if (model.role === 'asr') this.asrProvider = null;
          else this.translationProvider = null;
          this.set(model, 'integrity_failed');
          failures.push(`MODEL_INTEGRITY ${model.modelId}`);
          continue;
        }

        // 간단한 추론 자체 검사
        const ok = await this.selfTest(model);
        this.set(model, ok ? 'ready' : 'error', ok ? 'pass' : 'fail');
        if (!ok) {
          if (model.role === 'asr') this.asrProvider = null;
          failures.push(`self-test 실패 ${model.modelId}`);
        }
        onProgress?.({ modelId: model.modelId, loadedBytes: bytes, totalBytes: bytes || null, status: ok ? 'ready' : 'error' });
      } catch (e) {
        this.set(model, 'error', 'fail');
        failures.push(`${model.modelId}: ${String((e as Error)?.message ?? e)}`);
      }
    }

    if (failures.some((f) => f.startsWith('MODEL_INTEGRITY'))) {
      throw new EngineError('MODEL_INTEGRITY', `모델 파일이 manifest 와 다릅니다: ${failures.join('; ')}`, true);
    }
    if (!this.asrProvider) {
      throw new EngineError('MODEL_NOT_READY', `음성인식 모델 준비 실패: ${failures.join('; ')}`, true);
    }
  }

  private async selfTest(model: ModelManifest): Promise<boolean> {
    try {
      if (model.role === 'asr' && this.asrProvider) {
        // 1초 저잡음 — 예외 없이 끝나는지만 본다 (정확도 검사 아님)
        const pcm = new Float32Array(16000);
        for (let i = 0; i < pcm.length; i++) pcm[i] = (Math.random() * 2 - 1) * 0.001;
        await this.asrProvider.transcribe(pcm, { utteranceId: 'selftest', sessionId: 'selftest', utteranceIndex: 0, variant: 'raw', utteranceStartMs: 0 });
        return true;
      }
      if (model.role === 'translation' && this.translationProvider) {
        const out = await this.translationProvider.translate('[1] 작업 확인', 'en');
        return typeof out === 'string' && out.length > 0;
      }
    } catch {
      return false;
    }
    return false;
  }
}
