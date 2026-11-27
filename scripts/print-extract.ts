import fs from 'node:fs';
import { DEMO_CATALOG } from '../src/engine/catalog/demo-catalog';
import { analyzeUtterance } from '../src/engine/rules/compare';
import { extractCandidates } from '../src/engine/rules/extract';
import { buildSummary } from '../src/engine/translate/summary';
const truth = JSON.parse(fs.readFileSync('fixtures/audio/team3/truth.json', 'utf8')) as Record<string, { text: string }>;
const tr = (text: string) => ({ text, segments: [], modelVersion: null, wordAligned: false });
const task = { taskId: 't', version: 1, ownVessel: '한라호', targetVessel: '한라호', terminalId: null, berthId: null, note: '', createdAt: '', sourceReviewEventId: null };
for (const [f, t] of Object.entries(truth)) {
  const ex = extractCandidates(tr(t.text), 'raw', DEMO_CATALOG);
  console.log(`\n## ${f}\n  추출: ${ex.candidates.map((c) => `${c.field}=${c.value}`).join(', ')}`);
  const o = analyzeUtterance({ enhanced: tr(t.text), raw: tr(t.text), crossCheck: 'complete', task: task as never, catalog: DEMO_CATALOG });
  console.log(`  판정: ${o.comparison.kind} [${o.comparison.reasonCodes}]\n  요약: ${buildSummary({ ...o, enhancedTranscript: tr(t.text), rawTranscript: tr(t.text) } as never, 'en', DEMO_CATALOG)!.oneLine}`);
}
