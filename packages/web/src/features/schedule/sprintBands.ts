import type { SprintState, Task } from '@/types';

/**
 * Which rows of the schedule outline a sprint window covers (#2738, ADR-0803).
 *
 * This is the model half of the hybrid declaration: #2727 and #2737 made a row's
 * *delivery mode* visible (bar texture, outline gutter, chip), and this makes the
 * sprint *window* visible on the same timeline that carries the gated bars. The
 * claim the band exists to support is "hybrid is one plan" — so it is drawn into
 * the existing canvas beside the axis, bars, baseline and today line rather than
 * into a second view, and dependencies keep crossing it in both directions
 * because nothing about a band changes how links are routed.
 *
 * Everything here is pure geometry-free bookkeeping: row indices and ISO dates.
 * The canvas turns them into pixels (`drawSprintBands` in GanttRenderer.ts), the
 * ARIA overlay turns them into text. Neither owns the rule for *which* rows
 * belong to a sprint, so the two cannot disagree about what the band claims.
 */

/**
 * The subset of `ApiSprint` a band needs.
 *
 * Snake_case because it is the wire shape — `useSprints` hands back `ApiSprint`
 * unmapped, and re-casing it here would add a mapping layer whose only job is to
 * be kept in sync. `finish_date` is INCLUSIVE, like every other finish date in
 * the scheduler (see `dateToRight`).
 */
export interface SprintWindowSource {
  id: string;
  name: string;
  start_date: string;
  finish_date: string;
  state: SprintState;
}

/** One drawn band: a contiguous run of rows, and the window they sit inside. */
export interface SprintBand {
  sprintId: string;
  /** Sprint name, drawn as the band's label and read out by the ARIA overlay. */
  name: string;
  /** ISO date — window start (inclusive). */
  startDate: string;
  /** ISO date — window finish (inclusive; `dateToRight` closes the day). */
  finishDate: string;
  /** First covered row index into the task array the engine was given. */
  firstRow: number;
  /** Last covered row index, inclusive. */
  lastRow: number;
}

/**
 * A cancelled sprint draws nothing.
 *
 * PLANNED, ACTIVE and COMPLETED are all part of the cadence a planner is reading
 * the chart to see — the past sprints explain the shape of the plan behind the
 * today line as much as the live one explains the shape ahead of it. A CANCELLED
 * sprint is the one state that is *not* cadence: it named a window that never
 * governed any work, so drawing it would put a band over rows nothing scheduled.
 */
function drawsABand(state: SprintState): boolean {
  return state !== 'CANCELLED';
}

/**
 * The sprint a single row contributes to its ancestors, or `null` for none.
 *
 * Milestones contribute nothing, matching `deliveryModePresentation.contributedMode`
 * and the server's `task_classification._classify_row`: `is_milestone ⟺
 * delivery_mode = 'milestone' ⟺ duration = 0` is one coupled fact, and a gate
 * sitting inside a sprint-driven phase is a gate, not evidence that the phase is
 * split across sprints. Counting it would break the single-sprint test below on
 * exactly the hybrid plans the band exists for.
 */
function contributedSprint(task: Task): string | null {
  if (task.isMilestone) return null;
  return task.sprintId ?? null;
}

/**
 * Resolve, per row, the single sprint that row's subtree is driven by.
 *
 * A phase reads from its DESCENDANTS, not from its own `sprint` field — the same
 * rollup direction `computeRowModes` uses, and for the same reason: the band
 * describes the subtree the planner is looking at. A phase whose branches sit in
 * two different sprints resolves to `null` and draws no band of its own, so the
 * bands fall to the child runs that really are single-sprint. That is the honest
 * answer; a band spanning both would claim a window that governs neither branch.
 *
 * A phase with no contributing descendants (all gates, or no children) falls back
 * to its own `sprintId`, so a milestone-only phase committed to a sprint is not
 * silently dropped.
 *
 * A row that resolves to nothing then INHERITS its nearest resolved ancestor.
 * The issue asks for a band spanning the rows of a sprint-driven *subtree*, and
 * a subtree contains rows that carry no sprint of their own — a gate, or a task
 * nobody has committed yet. Without inheritance those rows would punch holes
 * through the middle of a band, which reads as a rendering fault rather than as
 * a fact about the plan. Inheritance cannot leak across a disagreement: a phase
 * only resolves to a single sprint when every one of its descendants contributes
 * that sprint and no other, so a child of a resolved phase can never disagree
 * with it.
 *
 * O(n): one pass to index children, one iterative post-order walk to roll up,
 * one pre-order walk to inherit. Iterative rather than recursive so a deep
 * imported WBS cannot blow the call stack.
 */
function resolveRowSprints(tasks: Task[]): Map<string, string | null> {
  const childIds = new Map<string, string[]>();
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    byId.set(task.id, task);
    if (task.parentId) {
      const siblings = childIds.get(task.parentId);
      if (siblings) siblings.push(task.id);
      else childIds.set(task.parentId, [task.id]);
    }
  }

  const resolved = new Map<string, string | null>();
  /**
   * What each row hands UP, kept separate from what it resolves to: a phase
   * resolves to a sprint only when its descendants agree, but it still hands up
   * that same set so a grandparent sees the disagreement rather than a
   * flattened "one of them".
   */
  const contributed = new Map<string, Set<string>>();

  const walk = (rootId: string): void => {
    const stack: Array<{ id: string; expanded: boolean }> = [{ id: rootId, expanded: false }];
    while (stack.length) {
      const frame = stack.pop();
      if (!frame) break;
      const kids = childIds.get(frame.id) ?? [];
      if (!frame.expanded && kids.length) {
        stack.push({ id: frame.id, expanded: true });
        for (const kid of kids) stack.push({ id: kid, expanded: false });
        continue;
      }
      const task = byId.get(frame.id);
      if (!task) continue;
      const ids = new Set<string>();
      for (const kid of kids) {
        for (const id of contributed.get(kid) ?? []) ids.add(id);
      }
      if (!ids.size) {
        const own = contributedSprint(task);
        if (own) ids.add(own);
      }
      contributed.set(frame.id, ids);
      resolved.set(frame.id, ids.size === 1 ? [...ids][0] : null);
    }
  };

  const roots: string[] = [];
  for (const task of tasks) {
    if (!task.parentId || !byId.has(task.parentId)) {
      roots.push(task.id);
      walk(task.id);
    }
  }
  // Rows whose parent id points outside the loaded set (filtered or collapsed
  // outline) were never reached from a root — resolve them standalone rather
  // than leaving them unattributed and punching a hole through a band.
  for (const task of tasks) {
    if (!resolved.has(task.id)) {
      roots.push(task.id);
      walk(task.id);
    }
  }

  // Top-down inheritance pass. Driven off the child index rather than off array
  // order, so it is correct even if the caller hands rows in some order other
  // than the flattened outline.
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop();
    if (id === undefined) break;
    const inherited = resolved.get(id) ?? null;
    for (const kid of childIds.get(id) ?? []) {
      if ((resolved.get(kid) ?? null) === null && inherited !== null) {
        resolved.set(kid, inherited);
      }
      stack.push(kid);
    }
  }

  return resolved;
}

/**
 * Group the outline into the sprint-window bands the canvas should draw.
 *
 * Bands are **maximal contiguous runs** of rows resolving to the same sprint, so
 * a sprint whose work is scattered across the WBS produces several bands rather
 * than one tall band swallowing the unrelated rows between them. That is the
 * whole correctness argument for this function: a band is a claim about every
 * row it covers, and spanning `min(row)…max(row)` would make that claim falsely
 * about rows in no sprint at all.
 *
 * @param tasks   The visible rows, in render order — the SAME array handed to
 *                `engine.setTasks`, since bands are addressed by row index.
 * @param sprints Every sprint on the project (`useSprints`); cancelled ones and
 *                any missing a window are skipped.
 */
export function computeSprintBands(
  tasks: Task[],
  sprints: readonly SprintWindowSource[],
): SprintBand[] {
  if (!tasks.length || !sprints.length) return [];

  const windows = new Map<string, SprintWindowSource>();
  for (const sprint of sprints) {
    if (!sprint.start_date || !sprint.finish_date) continue;
    if (!drawsABand(sprint.state)) continue;
    windows.set(sprint.id, sprint);
  }
  if (!windows.size) return [];

  const rowSprint = resolveRowSprints(tasks);
  const bands: SprintBand[] = [];

  let runSprintId: string | null = null;
  let runStart = 0;

  const closeRun = (endRow: number): void => {
    if (runSprintId === null) return;
    const window = windows.get(runSprintId);
    if (window) {
      bands.push({
        sprintId: window.id,
        name: window.name,
        startDate: window.start_date,
        finishDate: window.finish_date,
        firstRow: runStart,
        lastRow: endRow,
      });
    }
    runSprintId = null;
  };

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    // An unknown sprint id (cancelled, or a sprint past `useSprints`' first
    // page) breaks the run rather than extending it — the row is genuinely not
    // covered by a band, and merging across it would span rows in no window.
    const raw = task ? (rowSprint.get(task.id) ?? null) : null;
    const id = raw !== null && windows.has(raw) ? raw : null;
    if (id === runSprintId) continue;
    closeRun(i - 1);
    if (id !== null) {
      runSprintId = id;
      runStart = i;
    }
  }
  closeRun(tasks.length - 1);

  return bands;
}

/**
 * Per-row band, for the ARIA overlay's bar labels and hover titles.
 *
 * The band is a sighted-only encoding on an `aria-hidden` canvas, so without
 * this the sprint window a task sits in is unreachable by screen reader — the
 * same gap the delivery-mode suffix on `buildTaskAriaLabel` closes for #2727.
 * The whole band is handed over, not just its name, because *membership is not
 * the read*: what a sighted user takes from the band is where the bar sits
 * relative to the window's edges, and that needs the dates.
 */
export function sprintBandByTaskId(
  tasks: Task[],
  bands: readonly SprintBand[],
): Map<string, SprintBand> {
  const byTask = new Map<string, SprintBand>();
  for (const band of bands) {
    for (let i = band.firstRow; i <= band.lastRow; i++) {
      const task = tasks[i];
      if (task) byTask.set(task.id, band);
    }
  }
  return byTask;
}
