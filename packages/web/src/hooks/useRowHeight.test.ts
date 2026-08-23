import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRowHeight, useRowMetrics, useComfortableRows } from './useRowHeight';
import * as constants from '@/features/schedule/scheduleConstants';

/**
 * #2997 — the hook is the *subscription*, not a second calculation.
 *
 * The interesting assertions are not "44 on touch". They are: the number the
 * hook returns is the number the non-React engine is holding, and a pointer-class
 * flip mid-session actually re-renders. A component that only read the
 * `ROW_HEIGHT` binding would pass the first and fail the second, and the failure
 * would look like "the canvas repainted but the outline didn't".
 */

type Listener = (e: { matches: boolean }) => void;

function stubPointer(coarse: boolean) {
  const listeners: Listener[] = [];
  const mql = {
    get matches() {
      return coarse;
    },
    media: '(pointer: coarse)',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_: string, fn: Listener) => listeners.push(fn),
    removeEventListener: (_: string, fn: Listener) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    dispatchEvent: () => false,
  };
  vi.stubGlobal('matchMedia', (query: string) =>
    /pointer:\s*coarse/.test(query) ? mql : { ...mql, matches: false, media: query },
  );
  return {
    flip(next: boolean) {
      coarse = next;
      for (const fn of [...listeners]) fn({ matches: next });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  constants.syncComfortableRows(false);
  constants.syncRowMetrics(false);
});

describe('useRowHeight', () => {
  it('returns 28 on a fine pointer', () => {
    stubPointer(false);
    const { result } = renderHook(() => useRowHeight());
    expect(result.current).toBe(28);
  });

  it('returns 44 on a coarse pointer', () => {
    stubPointer(true);
    const { result } = renderHook(() => useRowHeight());
    expect(result.current).toBe(44);
  });

  it('returns the value the engine is holding, not a parallel calculation', () => {
    stubPointer(true);
    const { result } = renderHook(() => useRowHeight());
    // The canvas renderer and the hit index read `ROW_HEIGHT`. If these two ever
    // differ, bars drift from their rows and taps land on the wrong task —
    // silently, which is why this is asserted rather than assumed.
    expect(constants.ROW_HEIGHT).toBe(result.current);
    expect(constants.BAR_TOP_OFFSET).toBe(constants.resolveBarTopOffset(result.current));
  });

  it('re-renders when the pointer class flips mid-session (tablet gains a keyboard)', () => {
    const ctl = stubPointer(true);
    const { result } = renderHook(() => useRowHeight());
    expect(result.current).toBe(44);

    act(() => ctl.flip(false));

    expect(result.current).toBe(28);
    expect(constants.ROW_HEIGHT).toBe(28);
    expect(constants.BAR_TOP_OFFSET).toBe(5);
  });

  it('survives an environment with no matchMedia at all (SSR / bare jsdom)', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { result } = renderHook(() => useRowHeight());
    expect(result.current).toBe(28);
  });
});

describe('useRowMetrics', () => {
  it('hands back height, bar inset and grip width from one render', () => {
    stubPointer(true);
    const { result } = renderHook(() => useRowMetrics());
    expect(result.current).toEqual({
      rowHeight: 44,
      barTopOffset: 13,
      gripWidth: 44,
      // The grip takes a lane of its own on touch rather than laying a 44px hit
      // area over the WBS column's nudges.
      gripReserve: 44,
      coarse: true,
    });
  });

  it('keeps the fine-pointer geometry byte-identical to the pre-#2997 constants', () => {
    stubPointer(false);
    const { result } = renderHook(() => useRowMetrics());
    expect(result.current).toEqual({
      rowHeight: 28,
      barTopOffset: 5,
      gripWidth: 14,
      // Zero: a mouse gives up no row width to a grip it can aim at.
      gripReserve: 0,
      coarse: false,
    });
  });

  it('every returned value clears the 44px touch floor on a coarse pointer', () => {
    stubPointer(true);
    const { result } = renderHook(() => useRowMetrics());
    // Web rule 5 / WCAG 2.5.5 — the grip is rowHeight tall by `inset-y-0`, so
    // these two numbers are the two axes of the same target.
    expect(result.current.rowHeight).toBeGreaterThanOrEqual(44);
    expect(result.current.gripWidth).toBeGreaterThanOrEqual(44);
  });
});

/**
 * #3019 — Comfortable rows.
 *
 * Every assertion here is on the **fine** pointer, which is the entire point:
 * the option exists for the people a coarse-pointer heuristic cannot reach — a
 * desktop user who wants bigger targets — and the pre-existing tests only ever
 * exercised the coarse path, which is exactly why a dead control shipped.
 */
describe('Comfortable rows', () => {
  it('changes the rendered row height at a fine pointer', () => {
    stubPointer(false);
    const { result } = renderHook(() => useRowHeight());
    expect(result.current).toBe(28);

    act(() => {
      constants.syncComfortableRows(true);
    });

    expect(result.current).toBe(44);
  });

  it('re-renders a consumer that never sees the flag', () => {
    // The subscription is the thing being tested. A consumer that merely *read*
    // the live binding would return 28 forever here — and the symptom would be
    // 28px DOM rows drawn over 44px canvas bands, which looks like nothing at
    // all until a tap lands on the wrong task.
    stubPointer(false);
    const { result } = renderHook(() => useRowMetrics());
    expect(result.current.rowHeight).toBe(28);
    expect(result.current.barTopOffset).toBe(5);

    act(() => {
      constants.syncComfortableRows(true);
    });

    expect(result.current.rowHeight).toBe(44);
    // Derived, not declared — the bar stays centered rather than hugging the top
    // of a taller row.
    expect(result.current.barTopOffset).toBe(13);
    // And the engine is holding the same number the outline just rendered.
    expect(constants.ROW_HEIGHT).toBe(44);
  });

  it('leaves the grip lane on the pointer class, not on the height', () => {
    // Not an oversight. `gripWidth`/`gripReserve` answer "can this pointer aim?"
    // — a mouse still can, and still has hover — so a fine-pointer user who
    // asked for roomier rows does not silently lose 44px of the name column.
    // The grip still *grows*, because its height is the row's.
    stubPointer(false);
    const { result } = renderHook(() => useRowMetrics());

    act(() => {
      constants.syncComfortableRows(true);
    });

    expect(result.current.rowHeight).toBe(44);
    expect(result.current.gripWidth).toBe(14);
    expect(result.current.gripReserve).toBe(0);
    expect(result.current.coarse).toBe(false);
  });

  it('cannot shrink a coarse pointer back below the touch floor', () => {
    stubPointer(true);
    const { result } = renderHook(() => useRowHeight());
    expect(result.current).toBe(44);

    act(() => {
      constants.syncComfortableRows(false);
    });

    // The option raises a floor; it does not lower one. WCAG 2.5.5 is not a
    // preference.
    expect(result.current).toBe(44);
  });

  it('useComfortableRows installs the preference and releases it on unmount', () => {
    stubPointer(false);
    const rows = renderHook(() => useRowHeight());
    const owner = renderHook(({ on }) => useComfortableRows(on), {
      initialProps: { on: false },
    });
    expect(rows.result.current).toBe(28);

    owner.rerender({ on: true });
    expect(rows.result.current).toBe(44);

    // Leaving the Schedule must not leave a stale `true` latched for an
    // unrelated surface that reads the same row model (the program schedule
    // page, which has no Display menu of its own).
    owner.unmount();
    expect(rows.result.current).toBe(28);
    expect(constants.getComfortableRows()).toBe(false);
  });
});
