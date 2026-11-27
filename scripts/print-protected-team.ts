import { DEMO_TASK, TEAM_AUDIO_SCRIPT } from '../src/engine/fixtures/demo-scenario';
import { FIXTURE_TRANSLATIONS } from '../src/engine/fixtures/fixture-providers';
import { DEMO_CATALOG } from '../src/engine/catalog/demo-catalog';
import { analyzeUtterance } from '../src/engine/rules/compare';
import { buildProtectedSource } from '../src/engine/translate/protect';
const task = { ...DEMO_TASK, taskId: 't', version: 1, createdAt: '', sourceReviewEventId: null } as never;
const tr = (text: string) => ({ text, segments: [], modelVersion: null, wordAligned: false });
for (const [file, segs] of Object.entries(TEAM_AUDIO_SCRIPT)) for (const [i, seg] of segs.entries()) {
  const o = analyzeUtterance({ enhanced: tr(seg.enhanced), raw: tr(seg.raw ?? seg.enhanced), crossCheck: 'complete', task, catalog: DEMO_CATALOG });
  const src = buildProtectedSource({ ...o, enhancedTranscript: tr(seg.enhanced), rawTranscript: tr(seg.raw ?? seg.enhanced) } as never);
  const has = !!FIXTURE_TRANSLATIONS[src.protectedText];
  console.log(`${file}#${i + 1} ${o.comparison.kind} [${o.comparison.reasonCodes.join(',')}] 번역${has ? 'O' : 'X'}${has ? '' : '\n   ' + JSON.stringify(src.protectedText) + ' ' + JSON.stringify(src.tokens.map((t) => t.value))}`);
}
