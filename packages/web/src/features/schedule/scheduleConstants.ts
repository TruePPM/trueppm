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

/** Height of a task bar. Constant across pointer classes — only its inset moves. */
export const BAR_HEIGHT = 18;

/** Pure resolution: the only place the two heights are chosen between. */
export function resolveRowHeight(coarse: boolean): number {
  return coarse ? ROW_HEIGHT_COARSE : ROW_HEIGHT_FINE;
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
 * Current row height. **Live binding — do not copy into a module-scope const.**
 * SSR and jsdom (no `matchMedia`) resolve to the fine-pointer height.
 */
export let ROW_HEIGHT = resolveRowHeight(coarsePointerNow());

/** Current bar inset. Live binding, derived from `ROW_HEIGHT`. */
export let BAR_TOP_OFFSET = resolveBarTopOffset(ROW_HEIGHT);

/**
 * Point the row model at a pointer class. Idempotent and pure in its argument,
 * which is what makes it safe to call from `useRowHeight()` during render — two
 * calls with the same `coarse` leave the module in the same state, so a React
 * strict-mode double render, a re-render, and a media-query event are
 * indistinguishable here.
 *
 * Returns the resolved height so the caller cannot read a different number than
 * the one it just installed.
 */
export function syncRowMetrics(coarse: boolean): number {
  ROW_HEIGHT = resolveRowHeight(coarse);
  BAR_TOP_OFFSET = resolveBarTopOffset(ROW_HEIGHT);
  return ROW_HEIGHT;
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
 * Height of the Monte Carlo confidence row below the split pane.
 * 44px — meets touch-target minimums; outside the virtualizer so scroll sync
 * does not apply (not 28px like task rows).
 */
export const MC_ROW_HEIGHT = 44;
