/**
 * The bridge between the task mutation hooks and the reconciliation store
 * (ADR-0784 §D4, issue #2725).
 *
 * Preview registration happens at the HOOK, not at each call site: drag, resize,
 * the snap-to-project-start prompt, the milestone date popover and build-mode
 * date edits all route through `useRescheduleTask` / `useUpdateTask`, so one
 * pair of calls covers every current write path.
 *
 * The trade-off is recorded in the ADR: a future write path that writes dates
 * optimistically without going through these hooks silently opts out of
 * reconciliation, and no gate catches that.
 */
import { useReconcileStore } from '@/stores/reconcileStore';
import type { Task } from '@/types';

import type { ReconcileField } from './reconcileState';

/** The optimistic date fields this feature tracks, in cache (camelCase) form. */
interface OptimisticDates {
  start?: string;
  finish?: string;
}

/** Best-effort human message from a DRF error payload — detail, then first field. */
export function extractRejectReason(err: unknown): string {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === 'object') {
    const detail = (data as { detail?: unknown }).detail;
    if (typeof detail === 'string') return detail;
    const firstVal = Object.values(data as Record<string, unknown>)[0];
    if (Array.isArray(firstVal) && typeof firstVal[0] === 'string') return firstVal[0];
    if (typeof firstVal === 'string') return firstVal;
  }
  return "Couldn't save the change.";
}

function presentFields(optimistic: OptimisticDates): Array<[ReconcileField, string]> {
  const out: Array<[ReconcileField, string]> = [];
  if (typeof optimistic.start === 'string' && optimistic.start) out.push(['start', optimistic.start]);
  if (typeof optimistic.finish === 'string' && optimistic.finish)
    out.push(['finish', optimistic.finish]);
  return out;
}

/**
 * Open a preview entry for every date field an optimistic patch carries.
 *
 * `snapshot` is the pre-write cache, read only for the task's name — the strip
 * lists rejections after the row may have scrolled out of view, and re-reading
 * the name at render time would show the post-write value.
 */
export function recordSchedulePreview(
  snapshot: Task[] | undefined,
  taskId: string,
  optimistic: OptimisticDates,
): void {
  const fields = presentFields(optimistic);
  if (fields.length === 0) return;
  const taskName = snapshot?.find((t) => t.id === taskId)?.name ?? 'Task';
  const { registerPreview } = useReconcileStore.getState();
  for (const [field, value] of fields) {
    registerPreview({ taskId, taskName, field, value });
  }
}

/** Move every open preview for this write to `rejected`, with a Retry. */
export function rejectSchedulePreview(
  taskId: string,
  optimistic: OptimisticDates,
  reason: string,
  retry: (() => void) | null = null,
): void {
  const { reject } = useReconcileStore.getState();
  for (const [field] of presentFields(optimistic)) {
    reject(taskId, field, reason, retry);
  }
}

/**
 * Translate a `useUpdateTask` payload into the date fields this feature tracks.
 *
 * `optimisticTaskPatch` maps `planned_start` to `plannedStart` — the SNET
 * constraint — and never touches `start`, the value the row actually renders
 * (that is derived by `deriveBarGeometry` from planned/scheduled/early dates on
 * the next read). So the preview has to be registered from the AUTHORED
 * `planned_start`, not from the camelCase patch: what the planner asked for is
 * `start`'s intended value, and the divergence we owe them is exactly
 * "you asked for Oct 13, the plan says Oct 16".
 */
export function scheduleDatesFromUpdatePayload(vars: {
  planned_start?: string | null;
}): OptimisticDates {
  return typeof vars.planned_start === 'string' && vars.planned_start
    ? { start: vars.planned_start }
    : {};
}
