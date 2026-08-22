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
  // rest of the suite (jsdom, no matchMedia) assumes.
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
    // that only watches ROW_HEIGHT leaves the other two free to drift back.
    const DECLARATION = /\b(?:const|let|var)\s+(ROW_HEIGHT|BAR_TOP_OFFSET|BAR_HEIGHT)\s*=/g;
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(modules)) {
      if (/\.test\.tsx?$/.test(path)) continue;
      for (const m of String(source).matchAll(DECLARATION)) offenders.push(`${path}: ${m[0]}`);
    }

    expect(offenders.sort()).toEqual([
      './scheduleConstants.ts: const BAR_HEIGHT =',
      './scheduleConstants.ts: let BAR_TOP_OFFSET =',
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

    const LIVE = /\b(?:ROW_HEIGHT|BAR_TOP_OFFSET)\b/;
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
