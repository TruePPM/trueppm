import type { Task } from '@/types';

/**
 * Per-phase "sprint-assigned backlog lives in here" attribution for the
 * "N planned" at-a-glance badge (#1798, follow-up to #1790).
 *
 * The input `planned` is the sprint-assigned-backlog subset of
 * `useUnscheduledTasks` — a task with a `sprintId` set (the gutter predicate
 * guarantees such a task is `status === 'BACKLOG'`, i.e. uncommitted work
 * excluded from CPM). These carry no timeline bar, so without a signal on the
 * phase row "planned work exists" is invisible unless the tray is expanded.
 */
export interface PhasePlannedInfo {
  /** Count of sprint-assigned backlog tasks anywhere in the phase subtree. */
  count: number;
  /** Distinct target sprint ids, in first-seen order. */
  sprintIds: string[];
}

/** Display-ready badge model for one phase row (sprint ids resolved to names). */
export interface PhasePlannedBadge {
  count: number;
  /** The sprint the badge scrolls to when clicked (earliest-starting group). */
  primarySprintId: string | null;
  /** Target sprint names, ordered to match the gutter's group ordering. */
  sprintNames: string[];
}

/**
 * Map each ancestor phase/summary task id → the sprint-assigned backlog in its
 * subtree. Attribution walks each planned task's WBS ancestors by dotted
 * prefix, so a task at `'1.2.3'` contributes to phases `'1'` and `'1.2'` (a
 * phase badge counts everything nested beneath it, matching how a summary row
 * rolls up its children). Only rows that are actually summary tasks receive an
 * entry — a planned task whose prefix has no summary row is simply skipped.
 */
export function computePlannedByPhase(
  planned: Task[],
  allTasks: Task[],
): Map<string, PhasePlannedInfo> {
  const summaryIdByWbs = new Map<string, string>();
  for (const t of allTasks) {
    if (t.isSummary) summaryIdByWbs.set(t.wbs, t.id);
  }

  const out = new Map<string, PhasePlannedInfo>();
  for (const t of planned) {
    if (!t.sprintId) continue;
    const parts = t.wbs.split('.');
    // Ancestors only (stop before the task's own full path).
    for (let i = 1; i < parts.length; i++) {
      const ancestorWbs = parts.slice(0, i).join('.');
      const phaseId = summaryIdByWbs.get(ancestorWbs);
      if (!phaseId) continue;
      const info = out.get(phaseId) ?? { count: 0, sprintIds: [] };
      info.count += 1;
      if (!info.sprintIds.includes(t.sprintId)) info.sprintIds.push(t.sprintId);
      out.set(phaseId, info);
    }
  }
  return out;
}
