import type { TaskVersion, Transcript } from '../src/contracts';

export function tr(text: string, modelVersion = 'test'): Transcript {
  return { text, segments: [{ segmentId: 'seg-0', text, startMs: 0, endMs: 3000, confidence: null }], modelVersion, wordAligned: false };
}

export const TASK_V1: TaskVersion = {
  taskId: 'task-001',
  version: 1,
  ownVessel: '해동호',
  targetVessel: 'A선박',
  terminalId: 'PNIT',
  berthId: 'T3',
  note: '',
  createdAt: '2026-11-27T10:00:00.000Z',
  sourceReviewEventId: null,
};
