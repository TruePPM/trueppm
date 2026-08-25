import { describe, it, expect, afterEach } from 'vitest';
import {
  ROW_HEIGHT,
  ROW_HEIGHT_FINE,
  ROW_HEIGHT_COARSE,
  BAR_HEIGHT,
  BAR_TOP_OFFSET,
  HEADER_HEIGHT,
  GRIP_WIDTH_FINE,
  GRIP_WIDTH_COARSE,
  resolveRowHeight,
  resolveBarTopOffset,
  resolveGripWidth,
  resolveGripReserve,
  NUDGE_SIZE_FINE,
  NUDGE_SIZE_COARSE,
  NUDGE_GAP,
  resolveNudgeSize,
  resolveNudgeLaneWidth,
  resolveOutlineNudgeReserve,
  resolveOutlineGripReserve,
  resolveOutlineLeftReserve,
  syncRowMetrics,
} from './scheduleConstants';
import * as constants from './scheduleConstants';
import { buildHitIndex } from './engine/GanttHitIndex';
import * as hitIndexModule from './engine/GanttHitIndex';
import * as rendererModule from './engine/GanttRenderer';
import { buildScaleData } from './engine/GanttScaleData';
import type { Task } from '@/types';

/**
 * #2997 — the Schedule row model.
 *
 * The bug this file exists to make impossible is not "the number is wrong". It
 * is **two numbers**: a hit index built at one row height while the canvas
 * paints another. Nothing looks broken when that happens — taps just land on the
 * wrong task — so the assertions below are about *identity of source*, not about
 * 28 and 44.
 */

afterEach(() => {
  // Every test leaves the module on the fine-pointer height, which is what the
  // rest of the suite (jsdom, no matchMedia) assumes. Both inputs are reset:
  // since #3019 the height resolves from two, and leaving either latched leaks
  // a 44px row into the next test.
  constants.syncComfortableRows(false);
  syncRowMetrics(false);
});

describe('resolveRowHeight — the only place the two heights are chosen between', () => {
  it('is 28px on a fine pointer', () => {
    expect(resolveRowHeight(false)).toBe(28);
    expect(ROW_HEIGHT_FINE).toBe(28);
  });

  it('is 44px on a coarse pointer — web rule 5 / WCAG 2.5.5 touch floor', () => {
    expect(resolveRowHeight(true)).toBe(44);
    expect(ROW_HEIGHT_COARSE).toBe(44);
  });

  it('clears the 44px floor on a coarse pointer', () => {
    expect(resolveRowHeight(true)).toBeGreaterThanOrEqual(44);
  });

  /**
   * #3019 — Comfortable rows. The toggle persisted to localStorage and was read
   * by nothing; the fix makes it a second *input* here rather than a second
   * source of truth anywhere else.
   */
  describe('Comfortable rows raises the floor', () => {
    it('lifts a fine pointer to 44px — the case the shipped control did nothing for', () => {
      expect(resolveRowHeight(false, true)).toBe(44);
    });

    it('leaves a fine pointer at 28px when off', () => {
      expect(resolveRowHeight(false, false)).toBe(28);
      // Defaulting the parameter is what keeps the single-argument call sites
      // valid; this pins that the default is the lean reading.
      expect(resolveRowHeight(false)).toBe(resolveRowHeight(false, false));
    });

    it('cannot lower a coarse pointer — the touch floor is not a preference', () => {
      // The `max` semantic, stated as the property rather than the number: with
      // the option off, a coarse pointer is still on the WCAG 2.5.5 floor.
      expect(resolveRowHeight(true, false)).toBe(44);
      expect(resolveRowHeight(true, true)).toBe(44);
      for (const comfortable of [false, true]) {
        expect(resolveRowHeight(true, comfortable)).toBeGreaterThanOrEqual(
          resolveRowHeight(false, comfortable),
        );
      }
    });

    it('is the coarse height by identity, not by a matching literal', () => {
      // A fourth `44` would be the "agree by luck" failure this module exists to
      // prevent, one level up from the row height itself.
      expect(constants.ROW_HEIGHT_COMFORTABLE).toBe(ROW_HEIGHT_COARSE);
    });
  });
});

describe('syncComfortableRows — the second input, latched separately', () => {
  afterEach(() => constants.syncComfortableRows(false));

  it('installs the height and its derived inset, and reports the flag back', () => {
    constants.syncComfortableRows(true);
    expect(constants.ROW_HEIGHT).toBe(44);
    expect(constants.BAR_TOP_OFFSET).toBe(13);
    expect(constants.getComfortableRows()).toBe(true);
  });

  it('survives a pointer-class sync — the inputs do not clobber each other', () => {
    // The bug this prevents: eight components call `syncRowMetrics(coarse)` on
    // every render and none of them knows the preference. If that call reset the
    // second input, Comfortable rows would last exactly until the next render.
    constants.syncComfortableRows(true);
    syncRowMetrics(false);
    expect(constants.ROW_HEIGHT).toBe(44);
    expect(constants.getComfortableRows()).toBe(true);
  });

  it('notifies subscribers on a change and stays silent on a repeat', () => {
    let notified = 0;
    const unsubscribe = constants.subscribeComfortableRows(() => {
      notified += 1;
    });
    constants.syncComfortableRows(true);
    expect(notified).toBe(1);
    // Idempotent and silent — the owner's effect re-runs freely without
    // scheduling a render loop through the subscribers.
    constants.syncComfortableRows(true);
    expect(notified).toBe(1);
    constants.syncComfortableRows(false);
    expect(notified).toBe(2);
    unsubscribe();
    constants.syncComfortableRows(true);
    expect(notified).toBe(2);
  });

  it('returns the resolved height on both the changed and the unchanged path', () => {
    // The early return hands back `ROW_HEIGHT` rather than falling through, so a
    // caller cannot read a different number depending on whether its write was
    // the one that moved the value.
    expect(constants.syncComfortableRows(true)).toBe(44);
    expect(constants.syncComfortableRows(true)).toBe(44);
    expect(constants.syncComfortableRows(false)).toBe(28);
  });

  it('survives a listener that unsubscribes while being notified', () => {
    // The notify loop iterates a *copy* of the set for exactly this reason:
    // mutating a Set mid-iteration would skip the next listener, so the second
    // subscriber below would silently never fire.
    let first = 0;
    let second = 0;
    const off = constants.subscribeComfortableRows(() => {
      first += 1;
      off();
    });
    const offSecond = constants.subscribeComfortableRows(() => {
      second += 1;
    });

    constants.syncComfortableRows(true);
    expect(first).toBe(1);
    expect(second).toBe(1);

    constants.syncComfortableRows(false);
    expect(first).toBe(1);
    expect(second).toBe(2);
    offSecond();
  });
});

describe('resolveBarTopOffset — derived, so the bar stays centered at both heights', () => {
  it('reproduces the historical literal 5 at 28px, to the pixel', () => {
    // The pre-#2997 constant was a hardcoded 5. Fine-pointer geometry must be
    // byte-identical after the change or every existing renderer snapshot moves.
    expect(resolveBarTopOffset(28)).toBe(5);
  });

  it('centers an 18px bar in a 44px row rather than hugging the top', () => {
    expect(resolveBarTopOffset(44)).toBe(13);
    // The space above and below the bar is equal — that is what "centered" means
    // here, and it is the thing a second hardcoded 5 would silently break.
    expect(44 - BAR_HEIGHT - resolveBarTopOffset(44)).toBe(resolveBarTopOffset(44));
  });
});

describe('syncRowMetrics — the live bindings move together', () => {
  it('installs the coarse height and its derived bar inset in one step', () => {
    expect(syncRowMetrics(true)).toBe(44);
    expect(constants.ROW_HEIGHT).toBe(44);
    expect(constants.BAR_TOP_OFFSET).toBe(13);
  });

  it('is idempotent — a strict-mode double render installs the same value', () => {
    syncRowMetrics(true);
    const first = constants.ROW_HEIGHT;
    syncRowMetrics(true);
    expect(constants.ROW_HEIGHT).toBe(first);
    expect(constants.BAR_TOP_OFFSET).toBe(resolveBarTopOffset(first));
  });

  it('goes back down when the pointer class flips to fine mid-session', () => {
    syncRowMetrics(true);
    syncRowMetrics(false);
    expect(constants.ROW_HEIGHT).toBe(28);
    expect(constants.BAR_TOP_OFFSET).toBe(5);
  });

  it('defaults to the fine height under jsdom, which has no matchMedia', () => {
    // Guards the SSR / test-environment path: a module that threw or resolved to
    // `undefined` here would take the whole suite down at import time.
    expect(ROW_HEIGHT).toBe(28);
    expect(BAR_TOP_OFFSET).toBe(5);
  });
});

describe('one definition — the engine re-exports, it does not redeclare (#2997)', () => {
  it('GanttHitIndex and GanttRenderer read the same binding as scheduleConstants', () => {
    syncRowMetrics(true);
    // If either module still declared `export const ROW_HEIGHT = 28` this fails
    // — which is the entire point. A drifted hit index does not look broken.
    expect(hitIndexModule.ROW_HEIGHT).toBe(44);
    expect(rendererModule.ROW_HEIGHT).toBe(44);
    expect(hitIndexModule.BAR_TOP_OFFSET).toBe(13);
    expect(rendererModule.BAR_TOP_OFFSET).toBe(13);
  });

  it('the row model is declared in exactly one module', () => {
    // A source scan, not a behavioral assertion: the failure this guards is
    // somebody *adding* a second constant, which no test on the existing
    // consumers can see (rule 300 — gate the population, not the instance).
    const modules = import.meta.glob('../../**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    });

    // All three were triplicated before #2997, not just the row height — a gate
    // that only watches ROW_HEIGHT leaves the other two free to drift back. The
    // header trio joined in #3012 for the same reason and one more: splitting
    // one constant into two meanings ("the ruler band" vs "where row 0 starts")
    // is exactly the moment somebody re-declares the old name locally to avoid
    // touching an import.
    const DECLARATION =
      /\b(?:const|let|var)\s+(ROW_HEIGHT|BAR_TOP_OFFSET|BAR_HEIGHT|HEADER_HEIGHT|CHART_HEADER_HEIGHT|CADENCE_RAIL_HEIGHT)\s*=/g;
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(modules)) {
      if (/\.test\.tsx?$/.test(path)) continue;
      for (const m of String(source).matchAll(DECLARATION)) offenders.push(`${path}: ${m[0]}`);
    }

    expect(offenders.sort()).toEqual([
      './scheduleConstants.ts: const BAR_HEIGHT =',
      './scheduleConstants.ts: const CADENCE_RAIL_HEIGHT =',
      './scheduleConstants.ts: const HEADER_HEIGHT =',
      './scheduleConstants.ts: let BAR_TOP_OFFSET =',
      './scheduleConstants.ts: let CHART_HEADER_HEIGHT =',
      './scheduleConstants.ts: let ROW_HEIGHT =',
    ]);
  });

  it('nobody captures a live binding at module scope', () => {
    // The declaration scan above cannot see this one: `const rowH = ROW_HEIGHT;`
    // at column 0 declares a *different* name, so it passes cleanly — and it
    // freezes the fine-pointer value forever. The renderer deliberately hoists
    // into locals like that inside its hot loops (correct, and the right thing
    // for the paint path); this asserts none of those hoists has drifted up to
    // module scope, which is the one edit that would silently un-do #2997.
    const modules = import.meta.glob('../../**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    });

    // `CHART_HEADER_HEIGHT` is live from #3012; `HEADER_HEIGHT` is deliberately
    // NOT in this set — it is a genuine constant (the ruler's own height) and
    // capturing it is fine. Note `\b` cannot match inside `CHART_HEADER_HEIGHT`,
    // so the two names never shadow each other here.
    const LIVE = /\b(?:ROW_HEIGHT|BAR_TOP_OFFSET|CHART_HEADER_HEIGHT)\b/;
    // Column 0 = module scope; anything indented is inside a function body.
    const TOP_LEVEL_DECL = /^(?:export\s+)?(?:const|let|var)\s+[\w$]+[^\n;]*=[^\n;]*$/gm;

    const offenders: string[] = [];
    let importers = 0;
    for (const [path, source] of Object.entries(modules)) {
      const src = String(source);
      if (/\.test\.tsx?$/.test(path)) continue;
      if (!LIVE.test(src)) continue;
      importers += 1;
      for (const m of src.matchAll(TOP_LEVEL_DECL)) {
        // The owner may of course initialize its own bindings.
        if (path.endsWith('scheduleConstants.ts')) continue;
        if (LIVE.test(m[0])) offenders.push(`${path}: ${m[0].trim()}`);
      }
    }

    expect(offenders).toEqual([]);
    // Not vacuous: the scan has to have actually seen the consumers. If a
    // refactor renames the bindings this number collapses and the guard says so
    // instead of passing on an empty set.
    expect(importers).toBeGreaterThanOrEqual(6);
  });
});

describe('the hit index is built at the height the renderer paints', () => {
  const scales = buildScaleData('week', '2026-04-01', '2026-05-01');
  const tasks = ['a', 'b', 'c'].map(
    (id) =>
      ({
        id,
        name: `Task ${id}`,
        start: '2026-04-07',
        finish: '2026-04-14',
        duration: 7,
        progress: 0,
        wbs: '1',
        parentId: null,
        isCritical: false,
        isComplete: false,
        isSummary: false,
        isMilestone: false,
        status: 'NOT_STARTED',
        assignees: [],
        notes: '',
      }) as unknown as Task,
  );
  // A pixel comfortably inside every bar (all three share dates).
  const barX =
    scales.pxPerMs * (new Date('2026-04-09T00:00:00Z').getTime() - scales.start.getTime());

  /**
   * The regression that motivated #2997: a click at the vertical center of the
   * *painted* row n must resolve to task n. If the index kept 28 while the DOM
   * grew to 44, row 2's center (HEADER + 2*44 + 22 = 138) would land inside the
   * index's row 3 (HEADER + 3*28 = 112 … 140) and the tap would open the wrong
   * task with nothing on screen to explain it.
   */
  it.each([
    ['fine', false, 28],
    ['coarse', true, 44],
  ])('resolves a tap at the center of row n to task n (%s pointer)', (_label, coarse, h) => {
    syncRowMetrics(coarse);
    const idx = buildHitIndex(tasks, scales);
    for (let row = 0; row < tasks.length; row++) {
      const centerY = HEADER_HEIGHT + row * h + h / 2;
      const zone = idx.query(barX, centerY, coarse);
      expect(zone?.taskId).toBe(tasks[row].id);
      expect(zone?.rowIndex).toBe(row);
    }
  });

  it('reaches the whole painted bar band at the coarse row height', () => {
    syncRowMetrics(true);
    const idx = buildHitIndex(tasks, scales);
    // The bar is centered in the 44px row (top inset 13), and every pixel of it
    // resolves to its own row. A hit index still built at 28 would answer row 1
    // for most of row 0's bar.
    for (let row = 0; row < tasks.length; row++) {
      const barTop = HEADER_HEIGHT + row * 44 + 13;
      for (let y = barTop; y < barTop + BAR_HEIGHT; y += 1) {
        expect(idx.query(barX, y, true)?.rowIndex, `row=${row} y=${y}`).toBe(row);
      }
    }
  });

  it('never answers with a row the pointer is not over — at either height', () => {
    // The strong form: a y anywhere in the three-row span resolves to *its own*
    // row or to nothing. Returning a neighbour is the silent failure — the tap
    // opens the wrong task and the UI looks fine.
    for (const [coarse, h] of [
      [false, 28],
      [true, 44],
    ] as const) {
      syncRowMetrics(coarse);
      const idx = buildHitIndex(tasks, scales);
      for (let y = HEADER_HEIGHT; y < HEADER_HEIGHT + 3 * h; y += 1) {
        const expectedRow = Math.floor((y - HEADER_HEIGHT) / h);
        const hit = idx.query(barX, y, coarse);
        if (hit) expect(hit.rowIndex, `coarse=${coarse} y=${y}`).toBe(expectedRow);
      }
    }
  });
});

describe('the grip reserve', () => {
  it('is 44px wide on a coarse pointer so the drag handle is a 44x44 target', () => {
    // The grip's height is the row's, passed in explicitly (not `inset-y-0`,
    // which would stop at the row's border and measure 43) — so this width is
    // the second half of the same floor.
    expect(resolveGripWidth(true)).toBe(GRIP_WIDTH_COARSE);
    expect(resolveGripWidth(true)).toBeGreaterThanOrEqual(44);
    expect(resolveRowHeight(true)).toBeGreaterThanOrEqual(44);
  });

  it('stays narrow on a fine pointer — a mouse must not lose 44px of every row', () => {
    expect(resolveGripWidth(false)).toBe(GRIP_WIDTH_FINE);
    expect(GRIP_WIDTH_FINE).toBeLessThan(GRIP_WIDTH_COARSE);
  });

  it('reserves a lane only on a coarse pointer, and it is the grip\'s full width', () => {
    // Zero on a mouse: the 14px grip overlays the row's left edge and no column
    // gives up a pixel. On touch the reserve must equal the grip exactly — a
    // reserve narrower than the grip puts a 44px target back on top of the WBS
    // column's nudges, which is the failure the lane exists to prevent.
    expect(resolveGripReserve(false)).toBe(0);
    expect(resolveGripReserve(true)).toBe(resolveGripWidth(true));
  });
});

/**
 * #3026 — the ⇤/⇥ structural-nudge lane. Same model as the grip lane above, and
 * the assertions are about the same thing: identity of source, not the value.
 */
describe('the structural-nudge lane (#3026)', () => {
  it('takes its coarse size FROM the row-height owner rather than repeating 44', () => {
    // A second literal `44` in this module would agree with the row by luck. The
    // moment one moves, a control stops being as tall as its row — and nothing
    // looks broken, which is why rule 315 is about ownership.
    expect(NUDGE_SIZE_COARSE).toBe(ROW_HEIGHT_COARSE);
    expect(resolveNudgeSize(true)).toBeGreaterThanOrEqual(44);
  });

  it('leaves a mouse the compact pair — a fine pointer must not pay the touch floor', () => {
    expect(resolveNudgeSize(false)).toBe(NUDGE_SIZE_FINE);
    expect(NUDGE_SIZE_FINE).toBeLessThan(NUDGE_SIZE_COARSE);
  });

  it('sizes the lane for BOTH targets — neither may reach the floor by covering the other', () => {
    // #2997's finding, applied to a pair: a 44px target that only meets the
    // floor by swallowing its neighbour has moved the failure, not fixed it.
    expect(resolveNudgeLaneWidth(true)).toBe(2 * NUDGE_SIZE_COARSE + NUDGE_GAP);
    expect(resolveNudgeLaneWidth(true)).toBeGreaterThanOrEqual(2 * 44);
    expect(resolveNudgeLaneWidth(false)).toBe(2 * NUDGE_SIZE_FINE + NUDGE_GAP);
  });

  it('gives a VIEWER no lane at either pointer class — absence, not a reserved hole', () => {
    // Web rule 302 keeps indent/outdent absent for a reader with no rights, so
    // their rows must not give up the lane's width to reserve room for controls
    // that are never rendered.
    expect(resolveOutlineNudgeReserve(false, false)).toBe(0);
    expect(resolveOutlineNudgeReserve(true, false)).toBe(0);
    expect(resolveOutlineNudgeReserve(false, true)).toBe(resolveNudgeLaneWidth(false));
    expect(resolveOutlineNudgeReserve(true, true)).toBe(resolveNudgeLaneWidth(true));
  });

  it('unlike the grip, reserves its lane on a FINE pointer too', () => {
    // The grip is `absolute left-0` and overlays the row's edge at 14px, so a
    // mouse gives up nothing. The nudges are in flow and always drawn, so their
    // lane is real at both pointer classes — the pair used to take this width
    // out of the WBS column, which is exactly the coupling being removed.
    expect(resolveGripReserve(false)).toBe(0);
    expect(resolveOutlineNudgeReserve(false, true)).toBeGreaterThan(0);
  });

  it('follows the same pointer-class rule as the grip, so the two cannot drift', () => {
    // Both row-level touch affordances answer one question. Since #3019 the row
    // can also reach 44 from the Comfortable-rows preference at a fine pointer,
    // and neither control grows with it — whether they should is one decision
    // across the grip, this pair and the insert `+`, so this pins that they at
    // least still agree on the rule they do follow.
    for (const coarse of [false, true]) {
      expect(resolveNudgeSize(coarse) >= 44).toBe(resolveGripWidth(coarse) >= 44);
    }
  });

  it('sums BOTH lanes in one function, so no reader can learn about only one', () => {
    // `TaskListPanel`'s width, `ScheduleView`'s outline box, the pending rows,
    // the draft row and the drop indicator all position against "where the
    // columns start". Each adding the two itself is how one of them ends up a
    // lane out of step, which reads as a broken table rather than a constant
    // that drifted.
    for (const coarse of [false, true]) {
      for (const authorable of [false, true]) {
        expect(resolveOutlineLeftReserve(coarse, authorable)).toBe(
          resolveOutlineGripReserve(coarse, authorable) +
            resolveOutlineNudgeReserve(coarse, authorable),
        );
      }
    }
  });
});
