/**
 * The Schedule's row model — **one** owner for a value five independent
 * subsystems have to agree on to the pixel (#2997).
 *
 * ## Why this is a live binding and not a constant
 *
 * The row is 28px on a mouse and **44px on a coarse pointer**, so the outline's
 * rows and every control in them clear the 44px touch floor (web rule 5,
 * WCAG 2.5.5). That makes row height a *runtime* value, and a runtime value has
 * to reach consumers that are not React and cannot take a hook:
 *
 * | Consumer | Reads it for |
 * |---|---|
 * | `engine/GanttHitIndex` | bar geometry and pointer hit-testing |
 * | `engine/GanttRenderer` | every painted row band, bar, arrow and sprint band |
 * | `engine/GanttEngineImpl` | canvas virtualization window, row-from-y |
 * | `ScheduleView` | scroll-to-row math, canvas total height, arrow anchors |
 * | `ScheduleAriaOverlay` | its own virtualization window and row rects |
 * | `PreviewOverlay` | drag-preview bar y |
 * | `TaskListPanel` / `TaskListRow` | the DOM row height and the reorder delta |
 *
 * The renderer and the hit index must place row *n* at the same y or bars drift
 * from their rows and taps land on the wrong task — and **nothing looks broken
 * when they disagree**, which is why a second constant is the failure mode this
 * module exists to prevent. Before #2997 `ROW_HEIGHT` was declared **three**
 * times (here, `GanttHitIndex.ts`, `GanttRenderer.ts`) with the same literal;
 * those are now re-exports of this binding, so there is exactly one place a
 * number can change.
 *
 * `export let` + a setter gives every existing `rowIndex * ROW_HEIGHT` call site
 * the current value with no signature change and no per-row function call in the
 * 60fps paint loop — an ES module export is a *live binding*, so importers read
 * through to this variable rather than copying it at import time. Two rules
 * follow from that and both are load-bearing:
 *
 * 1. **Never capture it at module scope.** `const X = ROW_HEIGHT * 2` at the top
 *    of a module freezes the fine-pointer value forever. Read it inside the
 *    function (hoisting into a `const` *within* a hot loop is fine and is what
 *    the renderer does).
 * 2. **A React consumer must subscribe, not just read.** Reading the binding
 *    during render yields the right number but will not re-render when the
 *    pointer class flips (a tablet gaining a keyboard, a hybrid laptop). Call
 *    `useRowHeight()` (`@/hooks/useRowHeight`), which subscribes to the media
 *    query *and* is the thing that writes this binding — so the DOM list and the
 *    canvas can never resolve two different heights within one commit.
 */

/** Row height on a fine pointer (mouse / trackpad). */
export const ROW_HEIGHT_FINE = 28;
/**
 * Row height on a coarse pointer. 44px is web rule 5 / WCAG 2.5.5's touch
 * minimum, and matches `MC_ROW_HEIGHT` below — the value was never in question,
 * only the plumbing.
 */
export const ROW_HEIGHT_COARSE = 44;

/**
 * Row height when the user has asked for **Comfortable rows** (#3019).
 *
 * Deliberately an alias rather than a fourth `44` literal: the design's wording
 * is *"44px rows and larger controls when on, the same sizing the coarse-pointer
 * rule applies automatically"* — so this is not a number that happens to match
 * the coarse height, it **is** the coarse height, reached by a second route. A
 * separate literal here would be the "agree by luck" failure the module docstring
 * above describes, one level up.
 */
export const ROW_HEIGHT_COMFORTABLE = ROW_HEIGHT_COARSE;

/** Height of a task bar. Constant across pointer classes — only its inset moves. */
export const BAR_HEIGHT = 18;

/**
 * Pure resolution: the only place the heights are chosen between.
 *
 * Two inputs, and the rule between them is **max, not either/or** — the option
 * *raises the floor*. A coarse pointer is still 44px with Comfortable rows off
 * (the touch floor is not a preference), and turning it on at a fine pointer
 * lifts 28 to 44. Expressing it as `Math.max` rather than `coarse || comfortable`
 * is what keeps that property true if a third height is ever introduced: the
 * resolved height can only ever go up, never down, as inputs are added.
 *
 * `comfortable` is optional so the ~dozen existing single-argument call sites
 * stay valid — widening the parameter list rather than every caller.
 */
export function resolveRowHeight(coarse: boolean, comfortable = false): number {
  return Math.max(
    coarse ? ROW_HEIGHT_COARSE : ROW_HEIGHT_FINE,
    comfortable ? ROW_HEIGHT_COMFORTABLE : ROW_HEIGHT_FINE,
  );
}

/**
 * Vertical inset of a bar inside its row — derived, never declared.
 *
 * At 28px this is `(28 - 18) / 2 = 5`, exactly the literal it replaces, so fine
 * pointer geometry is unchanged to the pixel. Deriving it is what keeps a 44px
 * row from painting its bar hard against the top edge with 21px of dead space
 * below: the bar stays centered at both heights.
 */
export function resolveBarTopOffset(rowHeight: number): number {
  return (rowHeight - BAR_HEIGHT) / 2;
}

function coarsePointerNow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

/**
 * The two inputs the row height resolves from, latched at module scope.
 *
 * They are latched separately because they arrive from **different places at
 * different times**: the pointer class from a media query that every consumer of
 * `useRowHeight()` re-asserts on every render, and Comfortable rows from one
 * component's persisted preference, hydrated asynchronously from localStorage.
 * Neither writer knows the other's value, so neither may pass it — each sets its
 * own input and the recomputation reads both. Collapsing these into a single
 * `syncRowMetrics(coarse, comfortable)` would make the eight components that
 * only know the pointer class clobber the preference back to `false` on every
 * render.
 */
let coarsePointerInput = coarsePointerNow();
let comfortableRowsInput = false;

/**
 * Current row height. **Live binding — do not copy into a module-scope const.**
 * SSR and jsdom (no `matchMedia`) resolve to the fine-pointer height.
 */
export let ROW_HEIGHT = resolveRowHeight(coarsePointerInput, comfortableRowsInput);

/** Current bar inset. Live binding, derived from `ROW_HEIGHT`. */
export let BAR_TOP_OFFSET = resolveBarTopOffset(ROW_HEIGHT);

/** Re-resolve both live bindings from the currently latched inputs. */
function recomputeRowMetrics(): number {
  ROW_HEIGHT = resolveRowHeight(coarsePointerInput, comfortableRowsInput);
  BAR_TOP_OFFSET = resolveBarTopOffset(ROW_HEIGHT);
  return ROW_HEIGHT;
}

/**
 * Point the row model at a pointer class. Idempotent and pure in its argument,
 * which is what makes it safe to call from `useRowHeight()` during render — two
 * calls with the same `coarse` leave the module in the same state, so a React
 * strict-mode double render, a re-render, and a media-query event are
 * indistinguishable here.
 *
 * Returns the resolved height so the caller cannot read a different number than
 * the one it just installed. Note it returns the height resolved from **both**
 * inputs, not from `coarse` alone — a caller that knows only the pointer class
 * still gets the number the canvas is painting with.
 */
export function syncRowMetrics(coarse: boolean): number {
  coarsePointerInput = coarse;
  return recomputeRowMetrics();
}

/**
 * Subscribers to the Comfortable-rows input, so a React consumer can *subscribe*
 * rather than merely read (module docstring rule 2, web rule 315c).
 *
 * The pointer class already has a subscription mechanism — the media query
 * itself, which `useIsCoarsePointer()` listens to. Comfortable rows has no
 * ambient event to listen to, so the module has to provide one; without it a
 * `TaskListRow` deep in a memoized subtree would keep rendering 28px boxes
 * around 44px canvas bands, which is precisely the invisible disagreement this
 * module exists to prevent.
 */
const comfortableRowsListeners = new Set<() => void>();

/**
 * Install the user's Comfortable-rows preference (#3019).
 *
 * Idempotent, and **silent when unchanged** — the early return is what makes it
 * safe to call from an effect that re-runs on every render of its owner without
 * scheduling a render loop through the subscribers.
 */
export function syncComfortableRows(comfortable: boolean): number {
  if (comfortableRowsInput === comfortable) return ROW_HEIGHT;
  comfortableRowsInput = comfortable;
  const resolved = recomputeRowMetrics();
  for (const listener of [...comfortableRowsListeners]) listener();
  return resolved;
}

/** The latched Comfortable-rows input. `useSyncExternalStore` snapshot. */
export function getComfortableRows(): boolean {
  return comfortableRowsInput;
}

/** Subscribe to Comfortable-rows changes. Returns the unsubscribe function. */
export function subscribeComfortableRows(listener: () => void): () => void {
  comfortableRowsListeners.add(listener);
  return () => {
    comfortableRowsListeners.delete(listener);
  };
}

/**
 * Keep the binding correct for the non-React readers even before React mounts
 * and after it unmounts. `useRowHeight()` writes the same value from the same
 * `resolveRowHeight`, so the two paths cannot disagree — this one only removes
 * the window in which the engine would be reading a stale height while React
 * has not yet committed.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const mq = window.matchMedia('(pointer: coarse)');
  mq.addEventListener?.('change', (e) => syncRowMetrics(e.matches));
}

/**
 * Height of the canvas timeline header (major + minor date labels).
 * Must match TaskListHeader h-7 (28px) so task-list rows align with canvas bars.
 *
 * Deliberately **not** pointer-dependent: the header is a label band, not a
 * touch target, and both the outline header and the canvas header derive from
 * this one number. Growing it would misalign nothing but would cost a coarse
 * pointer 16px of the rows it came to read.
 */
export const HEADER_HEIGHT = 28;
/** WBS indent per level in pixels */
export const WBS_INDENT = 16;
/**
 * Width reserved at a row's left edge for the ⋮⋮ reorder grip (#347, #2954).
 *
 * The grip is the row's drag handle, so on a coarse pointer it is a real touch
 * target and takes the full 44px floor in both axes: this is the width, and the
 * height is the row's own (passed in, not `inset-y-0` — see `RowReorderHandle`
 * for why the border box costs a pixel).
 *
 * Nothing subtracts this from a column. The row's columns move over by
 * `resolveGripReserve()` instead, and `TaskListRow`'s `taskNameWidth` budget
 * (`widths.task - (level - 1) * WBS_INDENT - 26`) is unrelated — its 26 is the
 * fold caret (18) plus the cell's own left padding (8).
 */
export const GRIP_WIDTH_FINE = 14;
export const GRIP_WIDTH_COARSE = 44;
export function resolveGripWidth(coarse: boolean): number {
  return coarse ? GRIP_WIDTH_COARSE : GRIP_WIDTH_FINE;
}

/**
 * Horizontal space the row's columns give up so the grip has a **lane of its
 * own**, rather than a hit area laid over somebody else's control.
 *
 * Zero on a fine pointer: a 14px grip overlays the row's left edge, a mouse can
 * aim at it, and no column loses width. On a coarse pointer the grip is 44px —
 * wide enough to swallow the whole WBS column, whose outdent/indent nudges live
 * at its right edge — so the columns move over instead. A 44px target that only
 * reaches the floor by covering its neighbour has not met the floor; it has
 * moved the failure somewhere the tester will not look.
 *
 * Applied as a leading flex spacer, **not** as row padding: the grip is
 * `position: absolute; left: 0`, and an absolutely positioned child resolves
 * `left: 0` against its containing block's *padding* box — so padding would move
 * the grip along with the columns and reserve nothing.
 */
export function resolveGripReserve(coarse: boolean): number {
  return coarse ? GRIP_WIDTH_COARSE : 0;
}

/**
 * The outline's grip lane, given the pointer class AND whether the outline can
 * be authored at all (#2960).
 *
 * A viewer has no grip (web rule 302 makes the apparatus absent, not disabled),
 * so it must not give up 44px of its name column to a control that is not
 * rendered. That rule was already correct inside `TaskListPanel`, but the lane
 * is *not* subtracted from any column and *is* rendered inside the panel's
 * fixed-width box — so the panel's own `width` has to carry it too, and the
 * overlay offsets that position the legend and the unscheduled gutter have to
 * agree. Three readers, one rule: at the Timeline's ~268px outline a 44px
 * disagreement is a fifth of the name column, where at the Grid's ~600px it was
 * merely untidy.
 */
export function resolveOutlineGripReserve(coarse: boolean, authorable: boolean): number {
  return authorable ? resolveGripReserve(coarse) : 0;
}

/**
 * The structural-nudge pair — ⇤ outdent / ⇥ indent — and the lane it lives in
 * (#3026).
 *
 * ## Why the pair needs a lane of its own
 *
 * The buttons shipped *inside* the WBS cell, and that cell is conditional on
 * `visible.wbs` — a Display ▸ Columns preference. Turning off a column that has
 * nothing to do with restructuring therefore deleted indent and outdent from
 * every row, leaving the right-click menu as the only pointer route and
 * reinstating exactly the discoverability problem the design placed them there
 * to solve. A control's existence must not be a side effect of somebody else's
 * column choice, so the pair gets its own lane on the same model as the ⋮⋮ grip
 * (`resolveGripReserve` above): reserved by the panel, rendered by the header
 * and by every row, subtracted from no column.
 *
 * The lane sits immediately to the LEFT of where the WBS column draws, which
 * keeps two design constraints true at once: the pair is still adjacent to the
 * WBS number when that column is shown (the depth is stated right beside the
 * control that changes it), and it stays at the row's left edge — far from
 * delete, which sits alone at the far right. A structural nudge and a
 * destructive act must not be neighbours, so "free it from the WBS column" is
 * never solved by moving it rightward toward the other controls.
 *
 * ## Why the coarse size is 44 and where the 44 comes from
 *
 * `NUDGE_SIZE_COARSE` is `ROW_HEIGHT_COARSE`, not a second literal `44`. That is
 * web rule 315 taken literally: the row-height owner is the only place the touch
 * floor is written down, and a control sized to it should say so rather than
 * agree with it by luck.
 *
 * Note it keys on the **pointer class**, not on the resolved `ROW_HEIGHT`, which
 * since #3019 can also reach 44 from the Comfortable-rows preference at a fine
 * pointer. That is deliberate parity with `resolveGripWidth` rather than a
 * separate judgement: Comfortable rows currently raises the row without raising
 * the row's controls, and whether it should is one decision across the grip, this
 * pair and the insert `+` — not a divergence introduced here. `resolveNudgeSize`
 * takes the same argument as `resolveGripWidth` so the two cannot drift apart
 * while that stays true. The buttons were `w-4 h-4` and did not
 * grow at all on a coarse pointer — 16px targets inside a 44px row, on the one
 * surface whose stated reason to exist is that restructuring must not be
 * keyboard-only knowledge, for a user (tablet) who has no keyboard.
 *
 * The pair is two targets, so the lane is two of them plus the gap between —
 * 34px on a mouse, 90px on a finger. That width is the honest cost of the floor:
 * #2997 already recorded that a 44px target which only reaches the floor by
 * covering its neighbour has not met the floor, it has moved the failure
 * somewhere the tester will not look.
 */
export const NUDGE_SIZE_FINE = 16;
export const NUDGE_SIZE_COARSE = ROW_HEIGHT_COARSE;

/** Gap between the two nudges. `gap-0.5` in the markup this replaces. */
export const NUDGE_GAP = 2;

/** Edge length of ONE nudge button. Square, so this is both width and height. */
export function resolveNudgeSize(coarse: boolean): number {
  return coarse ? NUDGE_SIZE_COARSE : NUDGE_SIZE_FINE;
}

/** Width of the lane holding both nudges plus the gap between them. */
export function resolveNudgeLaneWidth(coarse: boolean): number {
  return 2 * resolveNudgeSize(coarse) + NUDGE_GAP;
}

/**
 * The outline's nudge lane, given the pointer class AND whether the outline can
 * be authored at all.
 *
 * Same gate and same reasoning as `resolveOutlineGripReserve`: a viewer never
 * sees indent/outdent (web rule 302 makes the apparatus absent, not disabled),
 * so a viewer's rows must not give up the lane's width to reserve room for
 * controls that are not rendered.
 */
export function resolveOutlineNudgeReserve(coarse: boolean, authorable: boolean): number {
  return authorable ? resolveNudgeLaneWidth(coarse) : 0;
}

/**
 * Everything the outline reserves at a row's left edge before its first column.
 *
 * The grip lane plus the nudge lane. This is the number the panel's own `width`
 * must carry, the number the pending and draft rows must space by, and the
 * number the drop indicator insets by — anything that positions against "where
 * the columns start" reads this rather than adding the two itself, so a reader
 * that learns about one lane and not the other cannot exist.
 */
export function resolveOutlineLeftReserve(coarse: boolean, authorable: boolean): number {
  return resolveOutlineGripReserve(coarse, authorable) + resolveOutlineNudgeReserve(coarse, authorable);
}

/** Visible breathing room between the nudge lane and the insert `+` disc. */
export const INSERT_LANE_GAP = 4;

/**
 * How far the insert `+`'s tap box reaches PAST its disc on a coarse pointer —
 * `before:-inset-3.5`, i.e. 3.5 × 4px (#3026).
 *
 * The disc is the mark; the `before:` box is what the browser hit-tests. So the
 * box is what has to clear the nudge lane, and offsetting the *disc* by a visual
 * gap alone is not enough — it leaves the invisible box overlapping the indent
 * button by `INSERT_TAP_INSET_COARSE - INSERT_LANE_GAP` (10px, over the button's
 * bottom-right corner). That is two 44px targets on the same pixels: precisely
 * the collision the lane was added to prevent, arriving from the other direction
 * and with no visual symptom whatsoever.
 *
 * Verified by hit-testing rather than by arithmetic: `document.elementFromPoint`
 * inside the overlap returns the `+`, not the nudge. jsdom computes no
 * pseudo-element geometry, so a unit test can only assert the *clearance*
 * property — one that restates this formula agrees with the bug. The browser
 * assertion is in `e2e/schedule-coarse-row-height.spec.ts`.
 */
export const INSERT_TAP_INSET_COARSE = 14;

/**
 * Gap from the nudge lane's right edge to the insert `+` disc.
 *
 * On a coarse pointer this absorbs the tap box's left overhang as well as the
 * visible gutter; on a fine pointer the `before:` box is not rendered at all, so
 * the gutter alone is the whole gap. The `+` is absolutely positioned, so
 * widening this costs the row no chrome — it moves the disc, not the columns.
 */
export function resolveInsertLaneGap(coarse: boolean): number {
  return coarse ? INSERT_LANE_GAP + INSERT_TAP_INSET_COARSE : INSERT_LANE_GAP;
}

/**
 * Height of the Monte Carlo confidence row below the split pane.
 * 44px — meets touch-target minimums; outside the virtualizer so scroll sync
 * does not apply (not 28px like task rows).
 */
export const MC_ROW_HEIGHT = 44;
