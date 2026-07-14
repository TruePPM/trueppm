/**
 * cellCap — exception-aware per-cell card cap for the desktop board matrix
 * (issue #1967, ADR-0420).
 *
 * A busy phase×status cell blows out its whole matrix row. When the per-user
 * `cellCap` pref is on, this pure selector picks which cards stay visible and
 * which collapse behind a "+N more" disclosure — WITHOUT ever hiding a signal:
 *
 *   - A WIP-BREACHED cell is never capped (handled by the caller, which skips
 *     this selector when wipState is at/over) — the overload pile stays visible.
 *   - An EXCEPTION card is never collapsed: on the critical path, blocked
 *     (dependency or human flag), running late (negative float), or assigned to
 *     the current user. These map to the `classifyCardSignal` tiers that are
 *     derivable from raw Task fields (blocked / critical / negative-float) plus
 *     the "my own" predicate; SLA-stale and EVM-behind tiers are display-gated
 *     and treated as non-exception here (fail-open: absent signal → show, never
 *     hide because a signal was unreadable).
 *   - The visible calm remainder respects the cell's CURRENT display order (the
 *     active board Sort). Overflow is the tail of that order, so when Sort is by
 *     priority (the common case) the top-priority calm cards stay visible.
 *   - The cap only collapses when it would hide at least MIN_OVERFLOW_TO_COLLAPSE
 *     cards — hiding a single card behind a button costs ~the height it saves.
 */
import type { Task } from '@/types';

/** Fixed cap applied when the user turns "Cap tall cells" on (ADR-0420). */
export const DEFAULT_CELL_CAP = 6;

/**
 * Don't collapse unless doing so hides at least this many cards. A "+1 more"
 * button occupies roughly the vertical space of the one card it would hide, so
 * collapsing a single card is pure friction with no density win.
 */
export const MIN_OVERFLOW_TO_COLLAPSE = 2;

export interface CellCapInput {
  /** The active cap (a positive integer). Callers pass a resolved number. */
  cap: number;
  /** The current user's resource id, or null when they have none on the project. */
  myResourceId: string | null;
}

export interface CellCapResult {
  /** Cards rendered above the fold, in the cell's original display order. */
  visible: Task[];
  /** Cards collapsed behind the "+N more" disclosure. Empty when not capped. */
  overflow: Task[];
}

/**
 * An exception card is always kept above the fold. Computed from raw Task fields
 * so the selector stays pure and context-free (no EVM/SLA config threading).
 */
export function isExceptionCard(task: Task, myResourceId: string | null): boolean {
  if (task.isCritical) return true;
  // Dependency-blocked (predecessor not complete).
  if (task.isBlocked) return true;
  // Human blocker flag (ADR-0124): a non-null age means the card is flagged
  // blocked and the viewer is allowed to see it.
  if (task.blockedAgeSeconds != null) return true;
  // Running late — negative total float.
  if (task.totalFloat != null && task.totalFloat < 0) return true;
  // Assigned to the current user (the rule-238 / 'My tasks' predicate).
  if (myResourceId != null && task.assignees.some((a) => a.resourceId === myResourceId)) {
    return true;
  }
  return false;
}

/**
 * Partition a cell's cards into the visible slice and the collapsed overflow.
 * The caller must NOT invoke this for a WIP-breached cell (breach exemption) —
 * that decision belongs upstream so `tasks.length` still drives the breach chip.
 */
export function selectVisibleCards(tasks: Task[], { cap, myResourceId }: CellCapInput): CellCapResult {
  // Fast path: the whole cell fits, or hiding would collapse < MIN cards.
  if (tasks.length <= cap + MIN_OVERFLOW_TO_COLLAPSE - 1) {
    return { visible: tasks, overflow: [] };
  }

  const exceptionIds = new Set<string>();
  for (const t of tasks) {
    if (isExceptionCard(t, myResourceId)) exceptionIds.add(t.id);
  }

  // Slots left for calm cards after every exception is kept. Exceptions may
  // exceed the cap — that's correct; the cap floors what's shown, it never
  // ceilings an exception out of view.
  const slotsForCalm = Math.max(0, cap - exceptionIds.size);
  const calmCount = tasks.length - exceptionIds.size;
  const calmToHide = calmCount - slotsForCalm;
  if (calmToHide < MIN_OVERFLOW_TO_COLLAPSE) {
    return { visible: tasks, overflow: [] };
  }

  // Walk the cell's current order: keep every exception + the first `slotsForCalm`
  // calm cards; the remaining calm tail overflows. Preserving order means we only
  // REMOVE the tail — we never resort the cards the user already knows.
  const visible: Task[] = [];
  const overflow: Task[] = [];
  let calmKept = 0;
  for (const t of tasks) {
    if (exceptionIds.has(t.id)) {
      visible.push(t);
    } else if (calmKept < slotsForCalm) {
      visible.push(t);
      calmKept += 1;
    } else {
      overflow.push(t);
    }
  }
  return { visible, overflow };
}
