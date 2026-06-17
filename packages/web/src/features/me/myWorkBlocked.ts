/**
 * Blocked-task selectors for the My Work surface (#1198).
 *
 * Pure helpers over the already-loaded `/me/work/` task list — the "N blocked"
 * chip and its tap-to-filter both read from data the page already holds, so no
 * extra request is made. "Blocked" here is the explicit human flag (`is_blocked`,
 * #476/#855), matching the row's blocked badge — not dependency readiness.
 */
import type { MyWorkTask } from '@/hooks/useMyWork';

/** Count of tasks a teammate has flagged as blocked. */
export function countBlocked(tasks: MyWorkTask[]): number {
  return tasks.reduce((n, t) => (t.is_blocked ? n + 1 : n), 0);
}

/**
 * The list to render. When `blockedOnly` is on, narrow to flagged-blocked tasks;
 * otherwise pass the list through unchanged. Kept as a selector so the filter is
 * unit-testable without standing up the whole page.
 */
export function selectVisibleTasks(tasks: MyWorkTask[], blockedOnly: boolean): MyWorkTask[] {
  return blockedOnly ? tasks.filter((t) => t.is_blocked) : tasks;
}
