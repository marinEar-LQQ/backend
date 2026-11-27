import type { LangCode, Transcript } from '../../contracts';
import type { AsrContext, AsrProvider, TranslationProvider } from '../providers';
import { DEMO_SCENARIO, type DemoLine } from './demo-scenario';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 시연 고정 ASR: 세션 내 발화 순번으로 시나리오 문장을 돌려준다. 실제 인식이 아니다. */
export class FixtureAsr implements AsrProvider {
  readonly modelVersion = 'fixture-asr-v1';
  readonly sampleRate = 16000 as const;

  constructor(
    private readonly lines: DemoLine[] = DEMO_SCENARIO,
    private readonly delayMs = 250,
  ) {}

  async transcribe(pcm16k: Float32Array, ctx: AsrContext): Promise<Transcript> {
    if (this.delayMs) await sleep(this.delayMs);
    const line = this.lines[ctx.utteranceIndex % Math.max(1, this.lines.length)];
    const text = line ? (ctx.variant === 'raw' ? line.raw : line.enhanced) : '';
    const endMs = ctx.utteranceStartMs + Math.round((pcm16k.length / 16000) * 1000);
    return {
      text,
      segments: [{ segmentId: `${ctx.utteranceId}-${ctx.variant}-0`, text, startMs: ctx.utteranceStartMs, endMs, confidence: null }],
      modelVersion: this.modelVersion,
      wordAligned: false,
    };
  }
}

/** placeholder 가 들어간 시연 문장 → 번역 (en/id/my). 미얀마어·인도네시아어는 원어민 검수 전. */
export const FIXTURE_TRANSLATIONS: Record<string, Partial<Record<LangCode, string>>> = {
  '[1], [2] 작업 [3] [4]로 변경입니다.': {
    en: '[1], [2] work changed to [3] [4].',
    id: '[1], pekerjaan [2] diubah ke [3] [4].',
    my: '[1]၊ [2] ၏ လုပ်ငန်းကို [3] [4] သို့ ပြောင်းလဲထားသည်။',
  },
  '[1] 작업 [2] [3]로 변경입니다.': {
    en: '[1] work changed to [2] [3].',
    id: 'Pekerjaan [1] diubah ke [2] [3].',
    my: '[1] ၏ လုပ်ငန်းကို [2] [3] သို့ ပြောင်းလဲထားသည်။',
  },
  '[1] 작업, [2]로 갑니다.': {
    en: '[1] work, heading to [2].',
    id: 'Pekerjaan [1], menuju ke [2].',
    my: '[1] ၏ လုပ်ငန်း၊ [2] သို့ သွားမည်။',
  },
  '[1], [2] [3]로 이동하세요.': {
    en: '[1], please move to [2] [3].',
    id: '[1], silakan pindah ke [2] [3].',
    my: '[1]၊ [2] [3] သို့ ရွှေ့ပါ။',
  },
  '[1] [2] [3] 접안 예정, [4]입니다.': {
    en: '[1] is scheduled to berth at [2] [3], at [4].',
    id: '[1] dijadwalkan sandar di [2] [3], pukul [4].',
    my: '[1] သည် [2] [3] တွင် [4] ၌ ဆိုက်ကပ်ရန် စီစဉ်ထားသည်။',
  },
  '[1] [2] 말고 [3] [4]로 정정합니다.': {
    en: '[1]: correction, not [2] but [3] [4].',
    id: '[1]: koreksi, bukan [2] melainkan [3] [4].',
    my: '[1]၊ ပြင်ဆင်ချက် - [2] မဟုတ်ဘဲ [3] [4] ဖြစ်သည်။',
  },
};

export class FixtureTranslator implements TranslationProvider {
  readonly modelVersion = 'fixture-translation-v1';
  constructor(
    private readonly table = FIXTURE_TRANSLATIONS,
    private readonly langs: LangCode[] = ['en', 'id', 'my'],
    private readonly delayMs = 150,
  ) {}

  supports(target: LangCode): boolean {
    return this.langs.includes(target);
  }

  async translate(text: string, target: LangCode): Promise<string> {
    if (this.delayMs) await sleep(this.delayMs);
    const hit = this.table[text]?.[target];
    if (!hit) throw new Error('시연 번역 데이터에 없는 문장입니다.');
    return hit;
  }
}

/**
 * 시연용 합성 음성 (발화마다 다른 기본 주파수의 음절형 신호 + 무전 잡음).
 * 실제 녹음이 아니다. 같은 합성음이 원음/완화음 양쪽에 쓰이지 않도록, 완화음은 엔진이 이 신호를 실제로 처리해 만든다.
 */
export function synthesizeScenarioAudio(lines: DemoLine[] = DEMO_SCENARIO, sampleRate = 16000, gapMs = 1500): Float32Array {
  const total = lines.reduce((n, l) => n + l.durationMs + gapMs, gapMs);
  const out = new Float32Array(Math.round((total / 1000) * sampleRate));
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < out.length; i++) out[i] = 0.004 * rnd(); // 배경 잡음
  let cursor = gapMs;
  lines.forEach((line, li) => {
    const f0 = 140 + li * 15;
    const start = Math.round((cursor / 1000) * sampleRate);
    const n = Math.round((line.durationMs / 1000) * sampleRate);
    for (let i = 0; i < n && start + i < out.length; i++) {
      const t = i / sampleRate;
      const syll = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t); // 초당 4음절
      const env = Math.min(1, i / 800, (n - i) / 800);
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
      out[start + i] = out[start + i]! + 0.12 * v * syll * env + 0.02 * rnd();
    }
    cursor += line.durationMs + gapMs;
  });
  return out;
}
