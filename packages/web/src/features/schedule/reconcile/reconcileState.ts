/**
 * The schedule reconciliation state machine (ADR-0784, issue #2725).
 *
 * The server owns every scheduled date; the client writes an optimistic preview
 * so the outline and the canvas move at pointer speed. This module is the pure
 * reducer that tracks the gap between the two, so a date the server changes out
 * from under the planner is never silent.
 *
 * Deliberately free of React, zustand, and the query cache: the acceptance test
 * for this feature is a state-machine test (`preview → acked → diverged →
 * acknowledged`), and it should not need a renderer to run. `reconcileStore`
 * wraps these functions; `useScheduleReconciliation` and the `task_dates_updated`
 * WebSocket handler both feed observations through {@link reconcile} so the two
 * delivery paths can never drift (ADR-0784 §D3).
 *
 * Every date here is a UTC-midnight ISO `YYYY-MM-DD` string, compared as a
 * string. No `Date` is constructed — a viewer-local read would shift the day for
 * anyone behind UTC (rule 56).
 */

/** The date fields a planner can author and the server can move. */
export type ReconcileField = 'start' | 'finish';

/**
 * Live states. `acked` and `acknowledged` are NOT stored — reaching either
 * evicts the entry (ADR-0784 §D1). Nothing ever reads a terminal entry, and
 * keeping them would grow the map for the length of a session.
 */
export type ReconcileStatus = 'preview' | 'diverged' | 'rejected';

export interface ReconcileEntry {
  taskId: string;
  field: ReconcileField;
  /** Task name at write time — the strip lists rejections after the row may have scrolled away. */
  taskName: string;
  status: ReconcileStatus;
  /**
   * The value the planner authored and is currently being shown.
   * For `diverged` this is the value they BELIEVED, retained as `from`.
   */
  expected: string;
  /** The server's authoritative value. Only set once `status === 'diverged'`. */
  actual: string | null;
  /** Server-supplied reason. Only set once `status === 'rejected'`. */
  reason: string | null;
  /**
   * Re-issues the refused mutation. Set alongside `reason` on rejection.
   *
   * Carried, never inspected — the reducer treats it as opaque data so the state
   * machine stays testable without a mutation layer. Re-issuing calls the same
   * hook whose `onMutate` registers a preview, so a retry transitions the entry
   * back to `preview` on its own rather than by a special-case transition.
   */
  retry: (() => void) | null;
  /** `Date.now()` at the moment the entry entered `preview`. Drives the TTL. */
  since: number;
}

/** Map key — one entry per task per field. */
export type ReconcileKey = `${string}:${ReconcileField}`;

export function reconcileKey(taskId: string, field: ReconcileField): ReconcileKey {
  return `${taskId}:${field}`;
}

export type ReconcileEntries = Readonly<Record<ReconcileKey, ReconcileEntry>>;

/**
 * A `preview` entry older than this is evicted with NO marker.
 *
 * It deliberately does not become `diverged`: an un-reconciled preview means we
 * never received an answer, and asserting a divergence we cannot evidence is
 * worse than dropping the italic (ADR-0784 §D1). 90 s is three fallback poll
 * intervals — if the socket is down and `useScheduleTasks` is polling at 30 s,
 * reconciliation has already had three chances to observe the truth.
 */
export const PREVIEW_TTL_MS = 90_000;

/** One observed server-authoritative value, from either delivery path. */
export interface ReconcileObservation {
  taskId: string;
  field: ReconcileField;
  /** The authoritative value, or null when the task has no such date. */
  value: string | null;
}

export interface PreviewInput {
  taskId: string;
  taskName: string;
  field: ReconcileField;
  /** The optimistic value just written to the cache. */
  value: string;
}

/**
 * Register an optimistic write. Supersedes any existing entry for the same
 * (task, field) — including a `diverged` one.
 *
 * Superseding matters: the planner has just re-authored that value, so they are
 * no longer being asked to spot a difference they themselves overwrote. Keeping
 * the old marker would be noise about a date that no longer exists
 * (ADR-0784 §D1).
 */
export function registerPreview(
  entries: ReconcileEntries,
  input: PreviewInput,
  nowMs: number,
): ReconcileEntries {
  const key = reconcileKey(input.taskId, input.field);
  return {
    ...entries,
    [key]: {
      taskId: input.taskId,
      field: input.field,
      taskName: input.taskName,
      status: 'preview',
      expected: input.value,
      actual: null,
      reason: null,
      retry: null,
      since: nowMs,
    },
  };
}

/**
 * Fold server-authoritative values into the entry map.
 *
 * Idempotent by construction (ADR-0784 §7): the next state is derived purely
 * from comparing the observed value against the stored `expected`, so replaying
 * the same `task_dates_updated` delta — the ADR-0236 replay window, or the
 * WebSocket and the fallback poll both delivering the same CPM run — yields an
 * identical map. This is why reconciliation is a comparison and not a counter.
 *
 * An observation for a task with no open entry is ignored: divergence is defined
 * against a LOCAL PREVIEW, never against the previously cached value. A task
 * whose dates move with no entry is a collaborator's edit or a CPM cascade onto
 * work this user never touched, and marking those would repaint the outline on
 * every teammate keystroke (ADR-0784 §D6).
 */
export function reconcile(
  entries: ReconcileEntries,
  observations: readonly ReconcileObservation[],
  nowMs: number,
): ReconcileEntries {
  let next: Record<ReconcileKey, ReconcileEntry> | null = null;

  for (const obs of observations) {
    const key = reconcileKey(obs.taskId, obs.field);
    const entry = (next ?? entries)[key];
    // No open preview → not ours to mark. A `rejected` entry is waiting on a
    // human (retry or dismiss), so an unrelated CPM pass must not clear it.
    if (!entry || entry.status === 'rejected') continue;
    if (obs.value === null) continue;

    if (obs.value === entry.expected) {
      // Acked — the server agreed with the preview. Evict.
      next ??= { ...entries };
      delete next[key];
      continue;
    }

    if (entry.status === 'diverged' && entry.actual === obs.value) continue; // no change

    next ??= { ...entries };
    next[key] = {
      ...entry,
      status: 'diverged',
      // `expected` is retained as authored: `from` is the value the PLANNER
      // believed, not the previous CPM pass. Two cascading runs must read as one
      // move away from what they typed, not a chain of machine states they never
      // saw (ADR-0784 §D1).
      actual: obs.value,
      since: entry.status === 'preview' ? nowMs : entry.since,
    };
  }

  return next ?? entries;
}

/** Move an entry to `rejected` — the server refused the write. */
export function reject(
  entries: ReconcileEntries,
  taskId: string,
  field: ReconcileField,
  reason: string,
  retry: (() => void) | null = null,
): ReconcileEntries {
  const key = reconcileKey(taskId, field);
  const entry = entries[key];
  if (!entry) return entries;
  return { ...entries, [key]: { ...entry, status: 'rejected', reason, retry } };
}

/** Drop one entry — acknowledging a divergence, or dismissing a rejection. */
export function acknowledge(
  entries: ReconcileEntries,
  taskId: string,
  field: ReconcileField,
): ReconcileEntries {
  const key = reconcileKey(taskId, field);
  if (!entries[key]) return entries;
  const next = { ...entries };
  delete next[key];
  return next;
}

/** Drop every `diverged` entry. Rejections survive — they still need a human. */
export function acknowledgeAllDiverged(entries: ReconcileEntries): ReconcileEntries {
  const keys = Object.keys(entries) as ReconcileKey[];
  const survivors = keys.filter((k) => entries[k].status !== 'diverged');
  if (survivors.length === keys.length) return entries;
  return Object.fromEntries(survivors.map((k) => [k, entries[k]])) as ReconcileEntries;
}

/**
 * Evict `preview` entries past {@link PREVIEW_TTL_MS}, and every entry whose
 * task is gone from the current snapshot.
 *
 * `knownTaskIds` is optional because the WebSocket delta path observes a subset
 * of tasks, not the whole project — pruning against that subset would evict
 * every untouched row's entry. Only the full-snapshot caller passes it.
 */
export function prune(
  entries: ReconcileEntries,
  nowMs: number,
  knownTaskIds?: ReadonlySet<string>,
): ReconcileEntries {
  const keys = Object.keys(entries) as ReconcileKey[];
  const survivors = keys.filter((k) => {
    const e = entries[k];
    if (knownTaskIds && !knownTaskIds.has(e.taskId)) return false;
    if (e.status === 'preview' && nowMs - e.since >= PREVIEW_TTL_MS) return false;
    return true;
  });
  if (survivors.length === keys.length) return entries;
  return Object.fromEntries(survivors.map((k) => [k, entries[k]])) as ReconcileEntries;
}

// --- Derived reads -------------------------------------------------------

export function divergedEntries(entries: ReconcileEntries): ReconcileEntry[] {
  return Object.values(entries).filter((e) => e.status === 'diverged');
}

export function rejectedEntries(entries: ReconcileEntries): ReconcileEntry[] {
  return Object.values(entries).filter((e) => e.status === 'rejected');
}

/** Task ids carrying a marker the review filter should narrow the outline to. */
export function reviewableTaskIds(entries: ReconcileEntries): Set<string> {
  const ids = new Set<string>();
  for (const e of Object.values(entries)) {
    if (e.status === 'diverged' || e.status === 'rejected') ids.add(e.taskId);
  }
  return ids;
}
