import { DEMO_SCENARIO, DEMO_TASK } from '../src/engine/fixtures/demo-scenario';
import { DEMO_CATALOG } from '../src/engine/catalog/demo-catalog';
import { analyzeUtterance } from '../src/engine/rules/compare';
import { buildProtectedSource } from '../src/engine/translate/protect';
import { buildSummary } from '../src/engine/translate/summary';
const task = { ...DEMO_TASK, taskId: 't', version: 1, createdAt: '', sourceReviewEventId: null } as never;
const tr = (text: string) => ({ text, segments: [], modelVersion: null, wordAligned: false });
for (const l of DEMO_SCENARIO) {
  const o = analyzeUtterance({ enhanced: tr(l.enhanced), raw: tr(l.raw), crossCheck: 'complete', task, catalog: DEMO_CATALOG });
  const r = { ...o, enhancedTranscript: tr(l.enhanced), rawTranscript: tr(l.raw) } as never;
  const src = buildProtectedSource(r);
  console.log(`${l.id} ${o.comparison.kind} [${o.comparison.reasonCodes.join(',')}]\n  P: ${src.protectedText}\n  T: ${JSON.stringify(src.tokens.map((t) => t.value))}\n  EN: ${buildSummary(r, 'en')!.oneLine}`);
}
