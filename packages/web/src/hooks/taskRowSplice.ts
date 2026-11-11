/**
 * Single-row splice for a remote `task_updated` frame (#2341).
 *
 * The frame carries `changed_fields` / `version` but never the values (they are
 * role-gated, ADR-0104, and a project-group broadcast cannot be gated per user).
 * Instead of invalidating `['tasks', projectId]` — which re-downloads every page
 * of a 1,000+ task project — we read the one task back through the serializer
 * (so per-user gating still applies) and patch that row into the cached list.
 *
 * Anything this cannot do safely falls back to the full coalesced invalidate:
 * structural fields (WBS numbering is array-index based), a row that is not
 * cached, a failed GET (a 404 for a deleted/moved task included), or a read
 * older than the frame that announced it.
 */
import type { QueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { mapTask, type ApiTask } from '@/hooks/useScheduleTasks';
import { mapWithConcurrency } from '@/utils/mapWithConcurrency';
import type { Task } from '@/types';

/** Frames for the same task inside this window share one GET. */
export const TASK_SPLICE_COALESCE_MS = 100;
/** Max single-row GETs in flight at once. */
export const TASK_SPLICE_CONCURRENCY = 3;
/**
 * More distinct tasks than this in one window is a bulk edit, where one list
 * refetch is cheaper than N row reads — and keeps total requests bounded.
 */
export const TASK_SPLICE_MAX_BURST = 20;

// Allow-list, not a deny-list: only fields whose change is local to the edited row
// may be spliced. Anything unknown takes the full refetch. Excluded on purpose:
//  - structural fields (parent, wbs_path, order/rank, structure_role,
//    auto_container, deleted_at): `computeWbsCodes` numbers siblings by array index;
//  - rollup inputs (percent_complete, status, duration, actual_*, is_milestone,
//    sprint, story_points): the serializer overwrites an ANCESTOR summary's (and a
//    milestone's) percent_complete from its children, but only the edited child is
//    broadcast, so splicing one row would leave ancestors stale;
//  - cross-row derived state (blocking_task, blocked_by, assignee, owners): they
//    change another row's `is_blocked` / `assignee_is_overallocated` (`owners` upserts
//    TaskResource rows, so the same resource's OTHER tasks can flip overallocated).
// TODO(#4950): rollup-input and cross-row edits still take the full refetch.
const SPLICEABLE_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'notes',
  'labels',
  'label_ids',
  'priority',
  'custom_fields',
  'custom_field_values',
]);

/**
 * True when the frame names a concrete set of changed fields that are ALL known
 * row-local ones. A missing/empty list (legacy emitters, `{"id"}`-only frames)
 * means "unknown", which must take the full-refetch path.
 */
export function isSpliceableChange(changedFields: unknown): boolean {
  if (!Array.isArray(changedFields) || changedFields.length === 0) return false;
  return changedFields.every((f) => typeof f === 'string' && SPLICEABLE_FIELDS.has(f));
}

export interface TaskRowSplicer {
  /** Queue a read-back of `taskId`; `version` is the frame's server_version. */
  request(taskId: string, version: number | null): void;
  /** Cancel pending work; in-flight results are discarded. */
  dispose(): void;
}

export function createTaskRowSplicer(opts: {
  queryClient: QueryClient;
  getProjectId: () => string | null | undefined;
  /** Full-list fallback (the coalesced `scheduleInvalidate('tasks')`). */
  fallback: () => void;
}): TaskRowSplicer {
  const { queryClient, getProjectId, fallback } = opts;
  const pending = new Map<string, number | null>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  // One flush at a time: a new 100 ms window must not start more GETs while a slow
  // batch is still running, or the in-flight count would be unbounded. An id in
  // flight is not re-fetched concurrently; a newer frame for it waits in `pending`.
  let flushing = false;
  const abort = new AbortController();

  async function readOne(
    projectId: string,
    taskId: string,
    frameVersion: number | null,
  ): Promise<boolean> {
    // Returns true when the row was handled (spliced or intentionally dropped).
    try {
      // `project` is what the server keys the active-baseline annotation on; without
      // it baseline_start/finish come back null and the splice would blank the overlay.
      const { data } = await apiClient.get<ApiTask>(`/tasks/${taskId}/`, {
        params: { project: projectId },
        signal: abort.signal,
      });
      if (disposed || getProjectId() !== projectId) return true;
      const fresh = mapTask(data);
      const key = ['tasks', projectId];
      const cached = queryClient.getQueryData<Task[]>(key);
      const idx = cached?.findIndex((t) => t.id === taskId) ?? -1;
      if (!cached || idx < 0) return false;
      const current = cached[idx];
      // A newer write already landed in the cache; this read lost the race.
      if (
        current.serverVersion !== undefined &&
        fresh.serverVersion !== undefined &&
        fresh.serverVersion < current.serverVersion
      ) {
        return true;
      }
      // The read is older than the frame that announced it (lagging replica):
      // splicing it in would show pre-edit values, so take the full path.
      if (
        frameVersion !== null &&
        fresh.serverVersion !== undefined &&
        fresh.serverVersion < frameVersion
      ) {
        return false;
      }
      queryClient.setQueryData<Task[]>(key, (old) =>
        // `wbs` is derived client-side from tree position, not by mapTask.
        old?.map((t) => (t.id === taskId ? { ...fresh, wbs: t.wbs } : t)),
      );
      return true;
    } catch {
      return false;
    }
  }

  async function flush(): Promise<void> {
    timer = null;
    if (flushing) return; // the running flush re-arms the timer when it ends
    const batch = [...pending];
    pending.clear();
    const projectId = getProjectId();
    if (!projectId || batch.length === 0) return;
    if (batch.length > TASK_SPLICE_MAX_BURST) {
      fallback();
      return;
    }
    flushing = true;
    try {
      const results = await mapWithConcurrency(batch, TASK_SPLICE_CONCURRENCY, ([id, v]) =>
        readOne(projectId, id, v),
      );
      if (!disposed && results.some((ok) => !ok)) fallback();
    } finally {
      flushing = false;
      if (!disposed && pending.size > 0) {
        timer ??= setTimeout(() => void flush(), TASK_SPLICE_COALESCE_MS);
      }
    }
  }

  return {
    request(taskId, version) {
      if (disposed) return;
      const prev = pending.get(taskId);
      pending.set(taskId, prev == null || version === null ? version : Math.max(prev, version));
      timer ??= setTimeout(() => void flush(), TASK_SPLICE_COALESCE_MS);
    },
    dispose() {
      disposed = true;
      abort.abort();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
