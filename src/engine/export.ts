import type { ComparisonKind, ExportFormat, ExportedFile, ReviewState, TaskLog, TaskVersion } from '../contracts';
import { SCHEMA_VERSION } from '../contracts';

const KIND_LABEL: Record<ComparisonKind, string> = {
  match: '일치',
  difference: '차이',
  ambiguous: '불명확',
  unrelated: '무관',
  unknown: '미확정',
};

const REVIEW_LABEL: Record<ReviewState, string> = {
  unreviewed: '미확인',
  reviewed: '확인함',
  dismissed: '관련 없음',
  applied: '기록 반영',
};

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function versionLine(v: TaskVersion): string {
  return `v${v.version} · 내 배 ${v.ownVessel} · 대상 ${v.targetVessel} · ${v.terminalId ?? '터미널 미지정'} ${v.berthId ?? ''}`.trim();
}

/**
 * 일지 내보내기. 음성 바이너리는 넣지 않는다 (audioRefs 메타데이터만).
 * 불확실 값은 확정값처럼 쓰지 않고 [A / B] 로 남긴다.
 */
export function exportLog(log: TaskLog, format: ExportFormat, exportedAt: string): ExportedFile {
  const stamp = exportedAt.replace(/[:.]/g, '-');
  if (format === 'json') {
    return {
      filename: `marinear-${log.task.taskId}-${stamp}.json`,
      mimeType: 'application/json',
      content: JSON.stringify({ schemaVersion: SCHEMA_VERSION, exportedAt, includesAudio: false, ...log }, null, 2),
      includesAudio: false,
    };
  }

  const lines: string[] = [];
  const active = log.versions.find((v) => v.version === log.task.activeVersion);
  lines.push('marinEar 작업 일지');
  lines.push(`작업 ${log.task.taskId} · 내보낸 시각 ${exportedAt}`);
  if (active) lines.push(`현재 기준: ${versionLine(active)}`);
  lines.push(
    `교신 ${log.counts.utterances}건 · 차이 ${log.counts.differences} · 불명확 ${log.counts.ambiguous} · 확인 ${log.counts.reviewed} · 관련 없음 ${log.counts.dismissed} · 반영 ${log.counts.applied} · 기준 변경 ${log.counts.taskChanges}`,
  );
  lines.push('※ 음성 파일은 포함하지 않았습니다. 판정은 교신 언급과 앱 기록의 차이이며 작업 지시 확정이 아닙니다.');
  lines.push('');
  lines.push('[작업 기준 변경]');
  for (const v of log.versions) {
    lines.push(`- ${v.createdAt} ${versionLine(v)}${v.sourceReviewEventId ? ' (교신 확인 후 반영)' : ''}`);
  }
  lines.push('');
  lines.push('[교신]');
  for (const e of log.utterances) {
    const r = e.results[e.results.length - 1];
    const u = e.utterance;
    lines.push(`- ${u.capturedAt} (세션 ${fmtMs(u.startMs)}–${fmtMs(u.endMs)}, 기준 v${u.taskVersion})`);
    if (!r) {
      lines.push('  분석 결과 없음 (원음 보존)');
      continue;
    }
    if (r.origin === 'fixture') lines.push('  [시연 고정 데이터]');
    lines.push(`  완화음 인식: ${r.enhancedTranscript?.text ?? '-'}`);
    lines.push(`  원음 인식: ${r.rawTranscript?.text ?? (r.crossCheck === 'pending' ? '(교차 검사 대기)' : '-')}`);
    const unc = r.uncertainties
      .filter((x) => x.field !== 'number')
      .map((x) => `${x.field}=[${x.alternatives.join(' / ')}]`)
      .join(', ');
    lines.push(`  판정: ${KIND_LABEL[r.comparison.kind]} (${r.comparison.reasonCodes.join(', ')})${unc ? ` · 불확실: ${unc}` : ''}`);
    for (const d of r.comparison.diffs) lines.push(`  차이: ${d.field} 기록 ${d.taskValue ?? '-'} / 교신 ${d.heardValue ?? '-'}`);
    for (const t of e.translations.filter((x) => x.sourceRevision === r.revision && x.status !== 'pending')) {
      lines.push(`  번역(${t.targetLang}, ${t.status}): ${t.text ?? '-'}`);
    }
    lines.push(`  사용자 확인: ${REVIEW_LABEL[e.reviewState]}`);
    for (const ev of e.reviewEvents) {
      lines.push(`    · ${ev.at} ${ev.action}${ev.action === 'apply' ? ` v${ev.taskVersionBefore}→v${ev.taskVersionAfter}` : ''}${ev.note ? ` "${ev.note}"` : ''}`);
    }
    const deleted = u.audioRefs.filter((a) => a.status === 'deleted').map((a) => a.variant);
    if (deleted.length) lines.push(`  삭제된 음성: ${deleted.join(', ')} (재생 불가)`);
  }
  lines.push('');
  lines.push('[메모]');
  for (const n of log.notes.filter((x) => !x.deleted)) lines.push(`- ${n.at} ${n.text}`);
  return {
    filename: `marinear-${log.task.taskId}-${stamp}.txt`,
    mimeType: 'text/plain;charset=utf-8',
    content: lines.join('\n'),
    includesAudio: false,
  };
}
