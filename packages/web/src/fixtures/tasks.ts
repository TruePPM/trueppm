import type { Task, TaskLink } from '@/types';

// Covers all bar types: normal, critical, complete, summary, milestone, baseline ghost.
// Covers all link types: FS, SS, FF, SF.
export const FIXTURE_TASKS: Task[] = [
  {
    id: 't1', wbs: '1', name: 'Alpha Platform Upgrade', start: '2026-10-05',
    finish: '2026-11-14', duration: 30, progress: 40, parentId: null,
    isCritical: false, isComplete: false, isSummary: true, isMilestone: false,
    status: 'IN_PROGRESS', assignees: [],
  },
  {
    id: 't2', wbs: '1.1', name: 'Discovery & Design', start: '2026-10-05',
    finish: '2026-10-16', duration: 10, progress: 100, parentId: 't1',
    isCritical: true, isComplete: true, isSummary: false, isMilestone: false,
    status: 'COMPLETE', assignees: [{ resourceId: 'r1', name: 'Alice Chen', units: 1.0 }],
    baselineStart: '2026-10-05', baselineFinish: '2026-10-14',
  },
  {
    id: 't3', wbs: '1.2', name: 'Backend Implementation', start: '2026-10-19',
    finish: '2026-10-30', duration: 10, progress: 60, parentId: 't1',
    isCritical: true, isComplete: false, isSummary: false, isMilestone: false,
    status: 'IN_PROGRESS', assignees: [
      { resourceId: 'r1', name: 'Alice Chen', units: 0.5 },
      { resourceId: 'r2', name: 'Bob Martinez', units: 1.0 },
    ],
    baselineStart: '2026-10-15', baselineFinish: '2026-10-26',
  },
  {
    id: 't4', wbs: '1.3', name: 'Frontend Build', start: '2026-10-26',
    finish: '2026-11-07', duration: 10, progress: 20, parentId: 't1',
    isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
    status: 'IN_PROGRESS', assignees: [
      { resourceId: 'r3', name: 'Carol Park', units: 1.0 },
      { resourceId: 'r4', name: 'David Lee', units: 0.6 },
      { resourceId: 'r5', name: 'Eve Johnson', units: 0.3 },
    ],
  },
  {
    id: 't5', wbs: '1.4', name: 'QA & Testing', start: '2026-11-02',
    finish: '2026-11-11', duration: 8, progress: 0, parentId: 't1',
    isCritical: true, isComplete: false, isSummary: false, isMilestone: false,
    status: 'NOT_STARTED', assignees: [],
  },
  {
    id: 't6', wbs: '1.5', name: 'Go-Live', start: '2026-11-14',
    finish: '2026-11-14', duration: 0, progress: 0, parentId: 't1',
    isCritical: true, isComplete: false, isSummary: false, isMilestone: true,
    status: 'NOT_STARTED', assignees: [],
  },
  {
    id: 't7', wbs: '2', name: 'Documentation', start: '2026-10-12',
    finish: '2026-10-23', duration: 10, progress: 30, parentId: null,
    isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
    status: 'IN_PROGRESS', assignees: [{ resourceId: 'r2', name: 'Bob Martinez', units: 1.0 }],
  },
];

export const FIXTURE_LINKS: TaskLink[] = [
  { id: 'l1', sourceId: 't2', targetId: 't3', type: 'FS', lag: 0, isCritical: true },
  { id: 'l2', sourceId: 't3', targetId: 't4', type: 'SS', lag: 0, isCritical: false },
  { id: 'l3', sourceId: 't4', targetId: 't5', type: 'FF', lag: 0, isCritical: false },
  { id: 'l4', sourceId: 't5', targetId: 't6', type: 'FS', lag: 0, isCritical: true },
  { id: 'l5', sourceId: 't2', targetId: 't7', type: 'SF', lag: 0, isCritical: false },
];
