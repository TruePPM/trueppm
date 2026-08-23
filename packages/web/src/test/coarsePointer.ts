import { syncRowMetrics, syncComfortableRows } from '@/features/schedule/scheduleConstants';

let previousMatchMedia: { had: boolean; value: unknown } | null = null;

/**
 * Make `(pointer: coarse)` answerable — and flippable — under jsdom (#2997).
 *
 * jsdom ships no `matchMedia` at all, so every coarse-pointer branch in the app
 * resolves to `false` by default and a test that means to exercise the 44px path
 * will quietly assert the 28px one. That failure is invisible: the test passes.
 *
 * Two things this stub gets right that a one-line `vi.stubGlobal` does not:
 *
 * - **`min-width:` queries keep answering for the reference desktop layout**, so
 *   a component that reads both a breakpoint and the pointer class does not
 *   silently collapse to its mobile branch as a side effect.
 * - **`flip()` dispatches a real `change` event** to every registered listener.
 *   The row model has two of them — `scheduleConstants`' module-level one, which
 *   keeps the non-React canvas engine correct, and `useIsCoarsePointer`'s, which
 *   turns the flip into a render. A stub that only changes `matches` exercises
 *   neither, and the mid-session flip (a tablet gaining a keyboard) is precisely
 *   the case where the DOM and the canvas can disagree.
 *
 * Call `restoreCoarsePointer()` in `afterEach`. The module binding is real
 * global state within a test file — vitest isolates files from each other, but
 * not tests within one — so leaving it at 44 makes every later test in the file
 * run at a row height it never asked for.
 *
 * It assigns `globalThis.matchMedia` directly rather than going through
 * `vi.stubGlobal`, so the paired restore touches **only** `matchMedia`.
 * `vi.unstubAllGlobals()` would also tear down whatever else the file stubbed
 * at module scope — `ScheduleAriaOverlay.test.tsx` stubs `ResizeObserver` that
 * way, and clearing it mid-file makes the next mount throw inside an effect.
 */
export function stubCoarsePointer(initial: boolean) {
  let coarse = initial;
  const listeners: ((e: { matches: boolean }) => void)[] = [];
  const mql = {
    get matches() {
      return coarse;
    },
    media: '(pointer: coarse)',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
      listeners.push(fn);
    },
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    dispatchEvent: () => false,
  };

  const g = globalThis as { matchMedia?: unknown };
  previousMatchMedia = { had: 'matchMedia' in g, value: g.matchMedia };
  g.matchMedia = (query: string) => {
    if (/pointer:\s*coarse/.test(query)) return mql;
    return { ...mql, matches: /^\(min-width:/.test(query), media: query };
  };

  // The module listener is registered at import time, long before this stub
  // exists, so it never sees these events — set the binding directly to match
  // what the real listener would have done.
  syncRowMetrics(initial);

  return {
    flip(next: boolean) {
      coarse = next;
      syncRowMetrics(next);
      for (const fn of [...listeners]) fn({ matches: next });
    },
  };
}

/** Undo {@link stubCoarsePointer} and put the row model back on 28px. */
export function restoreCoarsePointer(): void {
  const g = globalThis as { matchMedia?: unknown };
  if (previousMatchMedia) {
    if (previousMatchMedia.had) g.matchMedia = previousMatchMedia.value;
    else delete g.matchMedia;
    previousMatchMedia = null;
  }
  // Both inputs, not just the pointer class. Since #3019 the height resolves
  // from two latched values, so resetting one leaves the other free to hold the
  // row model at 44px — and this helper is the shared reset for six suites that
  // would then be asserting against a height nothing in them chose.
  syncComfortableRows(false);
  syncRowMetrics(false);
}
