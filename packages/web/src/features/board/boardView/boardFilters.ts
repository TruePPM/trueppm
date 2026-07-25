import type { Task, TaskStatus } from '@/types';
import { isTaskScheduled } from '@/lib/task';

/**
 * The board's task-level lenses. Shared verbatim by the phase grid, the queue
 * layout and the mobile snap board so switching layout can never reveal work
 * one of them had hidden.
 */
export interface BoardTaskFilters {
  /** Critical-path only — excludes uncommitted tasks (issue 332). */
  cpOnly: boolean;
  /** Finish within N days of today, or null for no window. */
  dueSoonDays: number | null;
  /** "My tasks" (issue 198) — opted in and the role default has resolved. */
  mineActive: boolean;
  /** The current user's resource on this project; null when they have none. */
  myResourceId: string | null;
  /** Tech-debt lens (ADR-0178, #1076). */
  debtOnly: boolean;
  /** At-risk lens — cards carrying ≥1 linked risk. */
  riskLinkedOnly?: boolean;
}

/** Midnight today, the stable reference point for the due-soon window. */
export function startOfToday(): Date {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

/**
 * CPM marks every *dated* task `isCritical`, including backlog ideas the PM
 * has not committed to — so the CP lens must also require the task to be
 * scheduled or it leaks uncommitted work into the visible set (issue 332).
 */
function passesCriticalPath(task: Task, cpOnly: boolean): boolean {
  return !cpOnly || (task.isCritical === true && isTaskScheduled(task));
}

/** Finish date falls inside [today, today + dueSoonDays]. Past-due is excluded. */
function passesDueSoon(task: Task, dueSoonDays: number | null, today: Date): boolean {
  if (dueSoonDays === null) return true;
  const diffMs = new Date(task.finish).getTime() - today.getTime();
  return diffMs >= 0 && diffMs <= dueSoonDays * 86_400_000;
}

/**
 * "My tasks" (issue 198). When the lens is on but the user has no resource on
 * the project, nothing matches — the dedicated empty state explains why, which
 * is more honest than silently showing everything.
 */
function passesMine(task: Task, mineActive: boolean, myResourceId: string | null): boolean {
  if (!mineActive) return true;
  if (myResourceId === null) return false;
  return task.assignees.some((a) => a.resourceId === myResourceId);
}

/** Single predicate for every board task-level lens. */
export function passesBoardFilters(task: Task, f: BoardTaskFilters, today: Date): boolean {
  if (!passesCriticalPath(task, f.cpOnly)) return false;
  if (!passesDueSoon(task, f.dueSoonDays, today)) return false;
  if (!passesMine(task, f.mineActive, f.myResourceId)) return false;
  if (f.riskLinkedOnly && (task.linkedRisksCount ?? 0) === 0) return false;
  if (f.debtOnly && task.taskType !== 'tech_debt') return false;
  return true;
}

/** An all-zero per-status counter. */
export function emptyStatusCounts(): Record<TaskStatus, number> {
  return { BACKLOG: 0, NOT_STARTED: 0, IN_PROGRESS: 0, REVIEW: 0, ON_HOLD: 0, COMPLETE: 0 };
}

/** An all-empty per-status task bucket. */
export function emptyStatusBuckets(): Record<TaskStatus, Task[]> {
  return { BACKLOG: [], NOT_STARTED: [], IN_PROGRESS: [], REVIEW: [], ON_HOLD: [], COMPLETE: [] };
}
