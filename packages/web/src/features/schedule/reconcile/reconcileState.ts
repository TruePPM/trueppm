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
 *
 * `cascade` (#3041) is the one state NOT born from a local write. It means "the
 * engine moved this row as a consequence of an edit — possibly someone else's —
 * and you never touched it". It is deliberately a separate status rather than a
 * flag on `diverged`, because the two make different claims and every reader has
 * to be able to tell them apart: `diverged` says *the server disagreed with what
 * you typed* and invites you to look again; `cascade` says *this moved on its own
 * account* and asks nothing of you. Collapsing them would tell a planner that
 * eleven consequences are eleven problems, which is the exact confusion the
 * reforecast panel (#2965) exists to remove.
 */
export type ReconcileStatus = 'preview' | 'diverged' | 'rejected' | 'cascade';

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

/**
 * A `cascade` entry older than this is evicted (#3041).
 *
 * Cascade entries need a bound that the other states do not, because **nothing
 * local creates them and nothing local clears them**. A `preview` is opened by a
 * write and closed by its answer; a `diverged` or `rejected` entry is a claim
 * against the planner that they dismiss. A cascade is neither — it arrives from
 * someone else's edit, and if it were left alone it would accumulate for the
 * length of the session.
 *
 * Ten minutes, not ninety seconds: unlike an unreconciled preview (where expiry
 * means "we never learned the answer" and asserting anything would be dishonest),
 * an expired cascade is simply old news. The planner had a reasonable window to
 * see what moved, and after that it is history rather than a reforecast.
 */
export const CASCADE_TTL_MS = 600_000;

/**
 * Hard ceiling on stored `cascade` entries.
 *
 * A memory guard, not a UX truncation — sized well above the ~12 rows the
 * reforecast panel shows at once, so in practice a planner sees everything that
 * moved. Past it the OLDEST cascades are evicted first, which keeps the most
 * recent run intact.
 *
 * Be honest about the ceiling above this one: when a CPM run moves too many rows
 * to ship as a delta, the server sets `truncated` and the client falls back to a
 * full refetch that carries no per-row `previous` at all — so a very large
 * cascade produces NO panel rows, which is exactly when a planner would most want
 * them. That is a pre-existing limit of the delta protocol, not something this
 * cap introduces, and closing it is server work.
 */
export const CASCADE_MAX_ENTRIES = 200;

/** One observed server-authoritative value, from either delivery path. */
export interface ReconcileObservation {
  taskId: string;
  field: ReconcileField;
  /** The authoritative value, or null when the task has no such date. */
  value: string | null;
  /**
   * The value this row held immediately before, when the caller KNOWS it moved.
   * Set only by the `task_dates_updated` delta path, which holds the old cached
   * row and the spliced new one at the same moment (#3041).
   *
   * This field is what makes cascade admission safe, and it is load-bearing.
   * The full-snapshot path in `useScheduleReconciliation` observes EVERY task on
   * every load and poll, and knows nothing about movement — so if a bare
   * observation could open a cascade entry, the first render of a 400-row project
   * would mark all 400. Leaving `previous` undefined there means that path
   * behaves exactly as it did before this change.
   */
  previous?: string | null;
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
 * An observation with no open entry and no `previous` is ignored: divergence is
 * defined against a LOCAL PREVIEW, never against the previously cached value.
 *
 * An observation with no open entry that DOES carry `previous` opens a `cascade`
 * entry (#3041). ADR-0784 §D6 declined to mark these, reasoning that doing so
 * "would repaint the outline on every teammate keystroke" — but that was true of
 * marking every *observation*, and only the delta path sets `previous`. It sets
 * it from a committed CPM run in which the row's dates actually moved, which is
 * not a keystroke; it is the event a planner has to defend in a plan review. The
 * full-snapshot path still passes no `previous` and still marks nothing.
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

    // A `rejected` entry is waiting on a human (retry or dismiss), so an
    // unrelated CPM pass must not clear it.
    if (entry?.status === 'rejected') continue;
    if (obs.value === null) continue;

    if (!entry) {
      // No open entry. Before #3041 this was the end of it. Now: if the caller
      // knows the row MOVED — only the delta path does — open a cascade entry.
      if (obs.previous === undefined || obs.previous === null) continue;
      if (obs.previous === obs.value) continue; // observed, but it did not move
      next ??= { ...entries };
      next[key] = {
        taskId: obs.taskId,
        field: obs.field,
        // The delta path does not carry a name. `ReforecastPanel` resolves the
        // name from `tasks` at render time, so an empty string here costs
        // nothing and avoids threading a task lookup into a pure reducer.
        taskName: '',
        status: 'cascade',
        // `expected` is what was ON SCREEN before the run — the value this
        // planner was reading. For `diverged` it is what they TYPED. Different
        // provenance, same slot, and the copy layer says which.
        expected: obs.previous,
        actual: obs.value,
        reason: null,
        retry: null,
        since: nowMs,
      };
      continue;
    }

    if (entry.status === 'cascade') {
      // A later run moved it again. Keep the ORIGINAL `expected`, matching the
      // §D1 rule for diverged: two cascading runs read as one move away from
      // what the planner last saw, not a chain of machine states.
      if (entry.actual === obs.value) continue;
      if (obs.value === entry.expected) {
        // It came back to where it started. There is nothing to report.
        next ??= { ...entries };
        delete next[key];
        continue;
      }
      next ??= { ...entries };
      next[key] = { ...entry, actual: obs.value };
      continue;
    }

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

/**
 * Drop every entry reporting a move — `diverged` and `cascade`.
 *
 * Rejections survive: they still need a human. Cascades go with the diverged
 * ones because Dismiss means "I have read what moved", and leaving the rows the
 * planner never touched behind would make the panel un-dismissable by anyone who
 * did not personally cause the run.
 */
export function acknowledgeAllDiverged(entries: ReconcileEntries): ReconcileEntries {
  const keys = Object.keys(entries) as ReconcileKey[];
  const survivors = keys.filter(
    (k) => entries[k].status !== 'diverged' && entries[k].status !== 'cascade',
  );
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
  let survivors = keys.filter((k) => {
    const e = entries[k];
    if (knownTaskIds && !knownTaskIds.has(e.taskId)) return false;
    if (e.status === 'preview' && nowMs - e.since >= PREVIEW_TTL_MS) return false;
    if (e.status === 'cascade' && nowMs - e.since >= CASCADE_TTL_MS) return false;
    return true;
  });

  // Cap the cascades, oldest first — see CASCADE_MAX_ENTRIES. Only cascades are
  // ever dropped for the cap: every other state is the planner's own work, and
  // silently evicting a rejection they have not answered would lose a refusal.
  const cascades = survivors.filter((k) => entries[k].status === 'cascade');
  if (cascades.length > CASCADE_MAX_ENTRIES) {
    const doomed = new Set(
      [...cascades]
        .sort((a, b) => entries[a].since - entries[b].since)
        .slice(0, cascades.length - CASCADE_MAX_ENTRIES),
    );
    survivors = survivors.filter((k) => !doomed.has(k));
  }

  if (survivors.length === keys.length) return entries;
  return Object.fromEntries(survivors.map((k) => [k, entries[k]])) as ReconcileEntries;
}

// --- Derived reads -------------------------------------------------------

export function divergedEntries(entries: ReconcileEntries): ReconcileEntry[] {
  return Object.values(entries).filter((e) => e.status === 'diverged');
}

/**
 * Every entry reporting a date that moved — the planner's own unconfirmed writes
 * AND the cascades onto rows they never touched (#3041).
 *
 * This, not `divergedEntries`, is what the reforecast panel and the polite
 * announcement count. The review STRIP deliberately keeps using
 * `divergedEntries`: its list is a set of claims against what the planner
 * authored, each with a Dismiss, and a row they never wrote has nothing for them
 * to answer there.
 */
export function movedEntries(entries: ReconcileEntries): ReconcileEntry[] {
  return Object.values(entries).filter(
    (e) => e.status === 'diverged' || e.status === 'cascade',
  );
}

export function rejectedEntries(entries: ReconcileEntries): ReconcileEntry[] {
  return Object.values(entries).filter((e) => e.status === 'rejected');
}

/** Task ids carrying a marker the review filter should narrow the outline to. */
export function reviewableTaskIds(entries: ReconcileEntries): Set<string> {
  const ids = new Set<string>();
  for (const e of Object.values(entries)) {
    if (e.status === 'diverged' || e.status === 'cascade' || e.status === 'rejected') {
      ids.add(e.taskId);
    }
  }
  return ids;
}
