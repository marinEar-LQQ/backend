import type { CatalogManifest, LangCode, ReviewCommand, TaskDraft } from './domain';
import { LANG_CODES } from './domain';

export interface ValidationIssue {
  field: string;
  message: string;
}

/** 작업 등록 검증: 필수값 + 장소가 카탈로그에 있는지 + 선석이 그 터미널 소속인지 */
export function validateTaskDraft(draft: TaskDraft, catalog: CatalogManifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!draft.ownVessel?.trim()) issues.push({ field: 'ownVessel', message: '내 배 이름이 필요합니다.' });
  if (!draft.targetVessel?.trim()) issues.push({ field: 'targetVessel', message: '대상 선박 이름이 필요합니다.' });

  if (draft.terminalId !== null) {
    const terminal = catalog.terminals.find((t) => t.terminalId === draft.terminalId);
    if (!terminal) {
      issues.push({ field: 'terminalId', message: `카탈로그(${catalog.catalogVersion})에 없는 터미널입니다.` });
    } else if (draft.berthId !== null && !terminal.berths.some((b) => b.berthId === draft.berthId)) {
      issues.push({ field: 'berthId', message: `${terminal.displayName}에 없는 선석입니다.` });
    }
  } else if (draft.berthId !== null) {
    issues.push({ field: 'berthId', message: '선석을 지정하려면 터미널이 필요합니다.' });
  }
  if (typeof draft.note !== 'string') issues.push({ field: 'note', message: '메모는 문자열이어야 합니다.' });
  return issues;
}

export function validateReviewCommand(cmd: ReviewCommand): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!cmd.requestId) issues.push({ field: 'requestId', message: '멱등 키(requestId)가 필요합니다.' });
  if (!cmd.utteranceId) issues.push({ field: 'utteranceId', message: 'utteranceId 가 필요합니다.' });
  if (!['review', 'dismiss', 'apply'].includes(cmd.action)) issues.push({ field: 'action', message: '알 수 없는 action' });
  if (!Number.isInteger(cmd.expectedResultRevision)) issues.push({ field: 'expectedResultRevision', message: '정수여야 합니다.' });
  if (!Number.isInteger(cmd.expectedTaskVersion)) issues.push({ field: 'expectedTaskVersion', message: '정수여야 합니다.' });
  if (cmd.action === 'apply') {
    if (!cmd.patch || Object.keys(cmd.patch).length === 0) {
      issues.push({ field: 'patch', message: 'apply 에는 사용자가 선택한 patch 가 필요합니다.' });
    }
  }
  return issues;
}

export function isLangCode(v: string): v is LangCode {
  return (LANG_CODES as readonly string[]).includes(v);
}

/** 기존 시안 언어 코드 마이그레이션 (tl → fil) */
export function migrateLangCode(v: string): LangCode | null {
  if (v === 'tl') return 'fil';
  return isLangCode(v) ? v : null;
}
