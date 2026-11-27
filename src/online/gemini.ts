/**
 * Gemini API 직접 호출 (중계 서버와 평가 스크립트에서만 사용 — 브라우저 코드에서 import 하지 않는다. 키가 노출된다).
 * 키는 헤더(x-goog-api-key)로만 보낸다. URL 에 넣지 않는다.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiOptions {
  apiKey: string;
  model: string;
  /** 무료 등급 속도 제한(429) 시 재시도 횟수 */
  retries?: number;
}

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

export class GeminiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

export async function geminiGenerate(opts: GeminiOptions, parts: GeminiPart[], config: Record<string, unknown> = {}): Promise<string> {
  const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, ...config } });
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/${opts.model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
      body,
    });
    if (res.ok) {
      const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      return (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      const detail = await res.text().catch(() => '');
      throw new GeminiError(res.status, `Gemini ${res.status}: ${detail.slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}

/** 전사 지시문. 용어 힌트는 "들린 경우에만" 쓰도록 명시한다 — 안 들린 코드를 지어내면 안 된다 */
export function transcribePrompt(hints: string[]): string {
  return [
    '이 음성은 부산항 주변 선박 VHF 무전 교신 녹음입니다. 들리는 그대로 받아 적으세요.',
    '- 한국어가 기본이고 영어 교신이 섞일 수 있습니다. 들린 언어 그대로 적고 번역하지 마세요.',
    '- 숫자는 들린 방식 그대로 적습니다 (예: "삼이공도", "팔 노트", "zero one five").',
    hints.length ? `- 이 해역에서 쓰이는 명칭 예: ${hints.join(', ')}. 실제로 그렇게 들린 경우에만 이 표기를 쓰고, 안 들린 명칭을 넣지 마세요.` : '',
    '- 잡음으로 안 들리는 부분은 추측해서 채우지 말고 건너뛰세요. 말소리가 없으면 빈 문자열을 출력하세요.',
    '- 설명·따옴표·화자 표시 없이 받아 적은 문장만 출력하세요.',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function geminiTranscribe(opts: GeminiOptions, wavBase64: string, hints: string[] = []): Promise<string> {
  return geminiGenerate(opts, [{ inline_data: { mime_type: 'audio/wav', data: wavBase64 } }, { text: transcribePrompt(hints) }]);
}
