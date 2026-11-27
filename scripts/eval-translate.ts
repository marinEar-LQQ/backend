/**
 * 번역 확인: 대본 문장 → 실제 엔진 경로(분석 → 보호 토큰 → Opus-MT 한→영→대상 → 복원·검증)로 en / id / vi 번역.
 *   npx vite-node --config vitest.config.ts scripts/eval-translate.ts
 */
import { DEMO_CATALOG } from '../src/engine/catalog/demo-catalog';
import { DEFAULT_ASSET_MANIFEST } from '../src/engine/assets/asset-manager';
import { OpusPivotTranslator } from '../src/engine/models/transformers-providers';
import { analyzeUtterance } from '../src/engine/rules/compare';
import { buildProtectedSource, restoreTokens } from '../src/engine/translate/protect';
import type { AnalysisResult, LangCode, TaskVersion, Transcript } from '../src/contracts';

const SENTENCES: Array<{ enh: string; raw?: string }> = [
  { enh: '현대부산호, 여기는 부산항 VTS. 현재 PNIT 1번 선석에서 출항 중인 외항선 있으니 속력 8노트로 감속하시고 좌현 대 좌현으로 통과하십시오.' },
  { enh: '한진오션호, 여기는 부산항 VTS. 현재 HJNC 전방 해역에 준설 작업선 작업 중이니 우현으로 여유 있게 우회하시고, PNC 3번 선석 도선사 승선 지점까지 이동하십시오.' },
  { enh: 'A선박 작업 HPNT T3로 변경입니다.', raw: 'A선박 작업 PNIT T3로 변경입니다.' },
  { enh: '한성호는 우현으로 크게 돌아서 어군 막아주고, 본선 좌현 100미터 거리 유지하면서 대기해라.' },
];
const LANGS: LangCode[] = ['en', 'id', 'vi'];

const task: TaskVersion = { taskId: 't', version: 1, ownVessel: '해동호', targetVessel: 'A선박', terminalId: 'PNIT', berthId: 'T3', note: '', createdAt: '', sourceReviewEventId: null };
const tr = (text: string): Transcript => ({ text, segments: [], modelVersion: null, wordAligned: false });

async function main() {
  const models = DEFAULT_ASSET_MANIFEST.models.filter((m) => m.role === 'translation');
  console.error(`모델 로딩: ${models.map((m) => m.modelId).join(', ')}`);
  const t0 = performance.now();
  const translator = await OpusPivotTranslator.create(models, 'cpu' as never);
  console.error(`로딩 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`지원 언어: ${(['en', 'id', 'vi', 'my'] as LangCode[]).map((l) => `${l}=${translator.supports(l) ? '예' : '아니오'}`).join(', ')}`);

  for (const s of SENTENCES) {
    const out = analyzeUtterance({ enhanced: tr(s.enh), raw: tr(s.raw ?? s.enh), crossCheck: 'complete', task, catalog: DEMO_CATALOG });
    const result = { ...out, enhancedTranscript: tr(s.enh), rawTranscript: tr(s.raw ?? s.enh) } as unknown as AnalysisResult;
    const src = buildProtectedSource(result);
    console.log(`\n원문: ${src.displayText}\n보호: ${src.protectedText}`);
    for (const lang of LANGS) {
      const t1 = performance.now();
      const raw = await translator.translate(src.protectedText, lang);
      const r = restoreTokens(raw, src.tokens);
      console.log(`  [${lang}] ${r.ok ? 'ready' : 'needs_check'} (${((performance.now() - t1) / 1000).toFixed(1)}s) ${r.text}${r.issues.length ? `  ⚠ ${r.issues.join('; ')}` : ''}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
