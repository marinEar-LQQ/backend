/**
 * NVIDIA NIM (OpenAI 호환 chat completions) 직접 호출 — 중계 서버와 평가 스크립트에서만 사용.
 * 브라우저 코드에서 import 하지 않는다 (키 노출).
 */

const URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

export interface NvidiaOptions {
  apiKey: string;
  model: string;
  retries?: number;
}

export async function nvidiaChat(opts: NvidiaOptions, system: string, user: string, maxTokens = 1200): Promise<string> {
  const body = JSON.stringify({
    model: opts.model,
    temperature: 0,
    max_tokens: maxTokens,
    // 생각 단계를 끈다: 켜 두면 번역 한 문장에 17초, 끄면 1초대 (2026-11-27 실측)
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` }, body });
    if (res.ok) {
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
      const text = json.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim()) return text.trim();
      throw new Error('NVIDIA 응답에 내용이 없습니다');
    }
    if ((res.status !== 429 && res.status < 500) || attempt >= retries) {
      throw new Error(`NVIDIA ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
  }
}

const LANG_NAME: Record<string, string> = { en: 'English', id: 'Indonesian (Bahasa Indonesia)', vi: 'Vietnamese', fil: 'Filipino', my: 'Burmese' };

export function translateSystemPrompt(target: string): string {
  return [
    `You translate Korean maritime VHF radio messages into ${LANG_NAME[target] ?? target} for foreign crew members.`,
    'Rules:',
    '- The input contains placeholders like [1], [2]. They stand for vessel names, terminal codes, berths, times and numbers. Copy every placeholder exactly once, unchanged, in the right position. Never translate, drop, renumber or invent placeholders.',
    '- Translate everything else faithfully and completely. Do not omit instructions (reduce speed, pass port to port, stand by, ...). Use standard maritime phrasing (IMO SMCP style).',
    '- Parts of the input that are already in English stay in English when the target is English; otherwise translate them too.',
    '- Do not add explanations, notes or quotation marks. Output only the translation.',
  ].join('\n');
}

export async function nvidiaTranslate(opts: NvidiaOptions, protectedText: string, target: string): Promise<string> {
  // 대상 언어를 사용자 메시지에도 다시 적는다 (생각을 끄면 시스템 지시의 언어를 놓치는 경우가 있었음)
  const out = await nvidiaChat(opts, translateSystemPrompt(target), `Translate into ${LANG_NAME[target] ?? target}. Output only the translation.

${protectedText}`);
  return out.replace(/^["“]|["”]$/g, '').trim();
}
