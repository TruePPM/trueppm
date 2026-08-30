import type { SprintState, Task } from '@/types';
import { postOrderRollup } from './postOrderRollup';

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
  // A subtree resolves to a sprint only when every descendant contributes that
  // same one; any disagreement resolves to null and draws no band of its own.
  const { resolved, roots, childIds } = postOrderRollup(tasks, contributedSprint, (ids) =>
    ids.size === 1 ? [...ids][0] : null,
  );

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
 * The sprints a band can be drawn for, indexed by id.
 *
 * A sprint missing either end of its window has no window to claim rows inside
 * of, and a cancelled one draws nothing (see {@link drawsABand}).
 */
function usableSprintWindows(
  sprints: readonly SprintWindowSource[],
): Map<string, SprintWindowSource> {
  const windows = new Map<string, SprintWindowSource>();
  for (const sprint of sprints) {
    if (!sprint.start_date || !sprint.finish_date) continue;
    if (!drawsABand(sprint.state)) continue;
    windows.set(sprint.id, sprint);
  }
  return windows;
}

/** One band: the run of rows, and the window they sit inside. */
function makeBand(window: SprintWindowSource, firstRow: number, lastRow: number): SprintBand {
  return {
    sprintId: window.id,
    name: window.name,
    startDate: window.start_date,
    finishDate: window.finish_date,
    firstRow,
    lastRow,
  };
}

/**
 * The band-drawing sprint a row belongs to, or `null`.
 *
 * An unknown sprint id (cancelled, or a sprint past `useSprints`' first page)
 * resolves to `null` so it breaks the run rather than extending it — the row is
 * genuinely not covered by a band, and merging across it would span rows in no
 * window.
 */
function bandedSprintId(
  task: Task | undefined,
  rowSprint: ReadonlyMap<string, string | null>,
  windows: ReadonlyMap<string, SprintWindowSource>,
): string | null {
  const raw = task ? (rowSprint.get(task.id) ?? null) : null;
  if (raw === null || !windows.has(raw)) return null;
  return raw;
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

  const windows = usableSprintWindows(sprints);
  if (!windows.size) return [];

  const rowSprint = resolveRowSprints(tasks);
  const bands: SprintBand[] = [];

  let runSprintId: string | null = null;
  let runStart = 0;

  const closeRun = (endRow: number): void => {
    if (runSprintId === null) return;
    const window = windows.get(runSprintId);
    if (window) bands.push(makeBand(window, runStart, endRow));
    runSprintId = null;
  };

  for (let i = 0; i < tasks.length; i++) {
    const id = bandedSprintId(tasks[i], rowSprint, windows);
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

/**
 * Whether a sprint draws a cell on the cadence rail at all.
 *
 * The single admission rule, shared by `computeCadenceSegments` and
 * {@link emptySprintWindows} — a sprint the rail never draws is not "missing"
 * from the announcement, and two copies of this predicate would eventually
 * disagree about which.
 *
 * An inverted window covers no days, so dropping it is the only honest option:
 * drawing it normalized would invent a window nobody planned.
 */
function drawsARailCell(sprint: SprintWindowSource): boolean {
  if (!sprint.start_date || !sprint.finish_date) return false;
  if (!drawsABand(sprint.state)) return false;
  const startMs = isoToUtcMs(sprint.start_date);
  const endMs = isoToUtcMs(sprint.finish_date);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  return endMs >= startMs;
}

/**
 * A sprint window that the cadence rail draws but no row band covers (#3060).
 *
 * This is the one fact the rail adds over the bands, and the one with nothing to
 * announce it. #3012 drew every sprint window on the time axis precisely so a
 * sprint with **no committed work** would appear — it drives no rows, so a row
 * band structurally cannot show it. But the canvas is `aria-hidden` and the
 * rail's only text channel is the per-row band description, which an empty
 * sprint by definition has no row to carry. A sighted user sees a window sitting
 * there waiting; a screen-reader user saw nothing at all.
 *
 * Only the empty ones, deliberately. #3012 ruled out a focusable stop in the
 * header — it would land N sprint stops ahead of every task row — and listing
 * the WHOLE cadence in a description region would read every non-empty sprint
 * twice, once here and once on each of its rows. What is missing is exactly the
 * sprints with no rows, so that is what gets named.
 */
export interface EmptySprintWindow {
  id: string;
  name: string;
  /** ISO date — window start (inclusive). */
  startDate: string;
  /** ISO date — window finish (inclusive). */
  finishDate: string;
}

/**
 * The drawable sprint windows that no band covers, in start order.
 *
 * Takes the bands rather than the tasks so it cannot disagree with what the
 * canvas actually painted: `computeSprintBands` is derived from `visibleTasks`,
 * so a sprint whose only rows are hidden by a filter or a collapsed phase is
 * empty *on this screen* — which is what the reader needs told, and what the
 * rail is already showing them.
 *
 * Mirrors `computeCadenceSegments`' admission rules exactly (cancelled sprints
 * and unparseable or inverted windows draw no cell, so they are not "missing"
 * from anything). Two functions applying one rule is a drift risk; the shared
 * predicate is {@link drawsARailCell}.
 */
export function emptySprintWindows(
  sprints: readonly SprintWindowSource[],
  bands: readonly SprintBand[],
): EmptySprintWindow[] {
  const banded = new Set(bands.map((b) => b.sprintId));
  return sprints
    .filter((s) => !banded.has(s.id) && drawsARailCell(s))
    .map((s) => ({
      id: s.id,
      name: s.name,
      startDate: s.start_date,
      finishDate: s.finish_date,
    }))
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// The cadence rail (#3012)
// ---------------------------------------------------------------------------

/**
 * One drawn cell of the sprint cadence rail: a stretch of *time* and the sprint
 * windows covering it.
 *
 * Note what this is NOT: a row range. `SprintBand` above answers "which rows
 * does this sprint drive"; a segment answers "which sprint owns this stretch of
 * the axis". They are two different claims and the rail exists because the band
 * cannot make the second one — three ways, each of which loses a sprint's name
 * from the picture entirely:
 *
 * 1. A sprint with **no committed work** produces no band, so an empty sprint —
 *    a real and important planning fact — is invisible today.
 * 2. Bands are maximal contiguous **row runs**, so a sprint scattered across the
 *    WBS produces several bands and therefore several copies of one name.
 * 3. The band's name pill was anchored at the band's first row, so scrolling
 *    past that row left the sprint anonymous for the rest of its own extent.
 *
 * The rail is a **label rail**: it names the window, it does not redraw it. The
 * bands still own the wash, the hatch and the row extent.
 */
export interface CadenceSegment {
  /** ISO date — segment start (inclusive). */
  startDate: string;
  /** ISO date — segment finish (inclusive; `dateToRight` closes the day). */
  finishDate: string;
  /**
   * What the rail writes in this cell: the covering sprint's name, or `N sprints`
   * where windows overlap.
   *
   * The count form is deliberate rather than a fallback. The rail is one row and
   * never stacks (a variable rail height re-opens the geometry problem every
   * frame), so an overlapped stretch cannot show both names — and showing one of
   * them would assert that the *other* sprint does not cover these days, which
   * is a lie about the plan rather than a truncation of it. "2 sprints" is the
   * honest reading and is itself worth seeing: overlapping cadence is usually a
   * data problem the planner wants to know about.
   */
  label: string;
  /** Covering sprint ids, in window-start order. Never empty. */
  sprintIds: string[];
  /**
   * Whether any covering sprint is ACTIVE.
   *
   * `any`, not `all`: the emphasis marks *where the team is now*, and an active
   * sprint overlapped by a planned one is still where the team is now.
   */
  active: boolean;
}

const MS_PER_DAY = 86_400_000;

/** ISO `YYYY-MM-DD` → UTC ms. Local-time parsing would shift a window a day. */
function isoToUtcMs(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
}

/** UTC ms → ISO `YYYY-MM-DD`. */
function utcMsToIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Partition the time axis into the cells the cadence rail should draw (#3012).
 *
 * The partition is cut at **every** window boundary — each start, and each
 * finish's day-after — and each resulting cell keeps the set of windows covering
 * it. That is what makes overlap representable in a single row without stacking:
 * an overlap is not a special case to detect, it is simply a cell whose covering
 * set has more than one member.
 *
 * Cells covered by nothing are dropped rather than emitted as gaps, so a project
 * whose sprints do not tile the axis renders rail cells only where cadence
 * actually exists — the space between two sprints is not a nameless sprint.
 *
 * Adjacent cells with an identical covering set are merged back together, so a
 * boundary that turns out not to change anything (two sprints sharing a start
 * date, a finish immediately followed by that same sprint's re-listing) does not
 * leave a hairline rule through the middle of one window.
 *
 * @param sprints Every sprint on the project (`useSprints`). Cancelled ones and
 *                any missing a window are skipped, via the SAME `drawsABand`
 *                predicate the row bands use — the rail and the band must never
 *                disagree about which sprints are drawable.
 */
export function computeCadenceSegments(
  sprints: readonly SprintWindowSource[],
): CadenceSegment[] {
  const windows: Array<{ id: string; name: string; startMs: number; endMs: number; active: boolean }> =
    [];
  for (const sprint of sprints) {
    if (!drawsARailCell(sprint)) continue;
    const startMs = isoToUtcMs(sprint.start_date);
    const endMs = isoToUtcMs(sprint.finish_date);
    windows.push({
      id: sprint.id,
      name: sprint.name,
      startMs,
      endMs,
      active: sprint.state === 'ACTIVE',
    });
  }
  if (!windows.length) return [];

  windows.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const cuts = new Set<number>();
  for (const w of windows) {
    cuts.add(w.startMs);
    cuts.add(w.endMs + MS_PER_DAY);
  }
  const boundaries = [...cuts].sort((a, b) => a - b);

  const segments: CadenceSegment[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const cellStart = boundaries[i];
    const cellEnd = boundaries[i + 1] - MS_PER_DAY;
    const covering = windows.filter((w) => w.startMs <= cellStart && w.endMs >= cellStart);
    if (!covering.length) continue;

    const sprintIds = covering.map((w) => w.id);
    const prev = segments[segments.length - 1];
    if (
      prev &&
      isoToUtcMs(prev.finishDate) + MS_PER_DAY === cellStart &&
      prev.sprintIds.length === sprintIds.length &&
      prev.sprintIds.every((id, idx) => id === sprintIds[idx])
    ) {
      prev.finishDate = utcMsToIso(cellEnd);
      continue;
    }

    segments.push({
      startDate: utcMsToIso(cellStart),
      finishDate: utcMsToIso(cellEnd),
      label: covering.length === 1 ? covering[0].name : `${covering.length} sprints`,
      sprintIds,
      active: covering.some((w) => w.active),
    });
  }

  return segments;
}
