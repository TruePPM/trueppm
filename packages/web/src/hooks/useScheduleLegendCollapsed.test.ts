import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  useMarkScheduleLegendSeen,
  useScheduleLegendCollapsed,
} from './useScheduleLegendCollapsed';

const STORAGE_KEY = 'trueppm.schedule.legend.collapsed.v1';
const SEEN_KEY = 'trueppm.schedule.legend.seen.v1';

/**
 * `useScheduleLegendCollapsed`'s seen-based default is cached once per module
 * lifetime (see the hook's own file header — this is REQUIRED by
 * `useSyncExternalStore`'s no-tearing contract, not an implementation detail
 * to work around). A test that wants to simulate the "next page load" must
 * therefore load a genuinely fresh module instance, the same way a real
 * reload would — `vi.resetModules()` + a dynamic re-import, not a second
 * `renderHook` against the already-imported module.
 */
async function freshModule() {
  vi.resetModules();
  return import('./useScheduleLegendCollapsed');
}

describe('useScheduleLegendCollapsed', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to expanded (collapsed = false) on first visit', () => {
    const { result } = renderHook(() => useScheduleLegendCollapsed());
    expect(result.current.collapsed).toBe(false);
  });

  it('toggle flips state and persists to localStorage', () => {
    const { result } = renderHook(() => useScheduleLegendCollapsed());
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false');
  });

  it('setCollapsed writes the explicit value to localStorage', () => {
    const { result } = renderHook(() => useScheduleLegendCollapsed());
    act(() => result.current.setCollapsed(true));
    expect(result.current.collapsed).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
  });

  it('restores collapsed state across reloads (acceptance criterion)', () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const { result } = renderHook(() => useScheduleLegendCollapsed());
    expect(result.current.collapsed).toBe(true);
  });

  it('treats any non-"true" stored value as expanded', () => {
    localStorage.setItem(STORAGE_KEY, 'garbage');
    const { result } = renderHook(() => useScheduleLegendCollapsed());
    expect(result.current.collapsed).toBe(false);
  });

  it('responds to cross-tab storage events', () => {
    const { result } = renderHook(() => useScheduleLegendCollapsed());
    expect(result.current.collapsed).toBe(false);
    act(() => {
      localStorage.setItem(STORAGE_KEY, 'true');
      // codeql suppression must sit on the alert's own line — a preceding-line
      // comment is inert. StorageEvent's 2nd arg is the valid optional
      // eventInitDict; js/superfluous-trailing-arguments mismodels the arity.
      window.dispatchEvent(
        new StorageEvent('storage', { key: STORAGE_KEY, newValue: 'true' }), // codeql[js/superfluous-trailing-arguments]
      );
    });
    expect(result.current.collapsed).toBe(true);
  });

  it('ignores storage events for unrelated keys', () => {
    const { result } = renderHook(() => useScheduleLegendCollapsed());
    act(() => {
      // codeql suppression must sit on the alert's own line — a preceding-line
      // comment is inert. StorageEvent's 2nd arg is the valid optional
      // eventInitDict; js/superfluous-trailing-arguments mismodels the arity.
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'some.other.key', newValue: 'true' }), // codeql[js/superfluous-trailing-arguments]
      );
    });
    expect(result.current.collapsed).toBe(false);
  });

  it('a same-session "seen" write never flips an already-rendered instance closed (#3614 regression)', () => {
    // The exact bug: `useSyncExternalStore` calls `getSnapshot()` on every
    // render of every subscribed instance, not only when the store notified —
    // so if marking "seen" changed what `getSnapshot()` returns THIS session,
    // the legend (or the toolbar button) would flip itself closed the very
    // next time anything re-rendered it, one paint after opening.
    const { result, rerender } = renderHook(() => {
      const state = useScheduleLegendCollapsed();
      useMarkScheduleLegendSeen(!state.collapsed);
      return state;
    });
    expect(result.current.collapsed).toBe(false);
    expect(localStorage.getItem(SEEN_KEY)).toBe('true');

    // Re-render for a reason that has nothing to do with this store — the
    // same thing a live ScheduleView does constantly (WS status, polling
    // badges, unrelated state). `getSnapshot()` must still return the SAME
    // value it returned a moment ago.
    rerender();
    rerender();
    expect(result.current.collapsed).toBe(false);
  });

  it('keeps two consumers in the same tab in sync (toolbar button + panel)', () => {
    // This is the bug a per-instance `useState` hook cannot fix: a
    // `StorageEvent` never fires in the document that made the write, so two
    // independent hook instances in one tab would disagree about `collapsed`
    // until a reload. The module-level external store must not have that gap.
    const { result } = renderHook(() => ({
      toolbar: useScheduleLegendCollapsed(),
      panel: useScheduleLegendCollapsed(),
    }));
    expect(result.current.toolbar.collapsed).toBe(false);
    expect(result.current.panel.collapsed).toBe(false);

    act(() => result.current.toolbar.toggle());
    expect(result.current.toolbar.collapsed).toBe(true);
    expect(result.current.panel.collapsed).toBe(true);

    act(() => result.current.panel.setCollapsed(false));
    expect(result.current.toolbar.collapsed).toBe(false);
    expect(result.current.panel.collapsed).toBe(false);
  });

  it('does NOT mark the legend seen by itself — only useMarkScheduleLegendSeen does (#3614)', () => {
    // `ScheduleLegendToggle` calls only `useScheduleLegendCollapsed`, never
    // `useMarkScheduleLegendSeen` — the toolbar button existing must not, by
    // itself, close the legend on the visit that first shows it.
    renderHook(() => useScheduleLegendCollapsed());
    expect(localStorage.getItem(SEEN_KEY)).toBeNull();
  });

  // --- #3614: default-closed-after-first-visit across a real page load -----

  it('defaults to closed on the NEXT page load once it has been seen, with no explicit choice', async () => {
    const first = await freshModule();
    renderHook(() => {
      const state = first.useScheduleLegendCollapsed();
      first.useMarkScheduleLegendSeen(!state.collapsed);
      return state;
    });
    expect(localStorage.getItem(SEEN_KEY)).toBe('true');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull(); // no explicit choice made

    const second = await freshModule();
    const { result: nextLoad } = renderHook(() => second.useScheduleLegendCollapsed());
    expect(nextLoad.current.collapsed).toBe(true);
  });

  it('an explicit choice to stay open survives being seen and the next page load', async () => {
    const first = await freshModule();
    const { result } = renderHook(() => first.useScheduleLegendCollapsed());
    act(() => result.current.setCollapsed(false));
    renderHook(() => first.useMarkScheduleLegendSeen(true));

    const second = await freshModule();
    const { result: nextLoad } = renderHook(() => second.useScheduleLegendCollapsed());
    expect(nextLoad.current.collapsed).toBe(false);
  });

  it('an explicit choice to close survives being seen and the next page load', async () => {
    const first = await freshModule();
    const { result } = renderHook(() => first.useScheduleLegendCollapsed());
    act(() => result.current.setCollapsed(true));

    const second = await freshModule();
    const { result: nextLoad } = renderHook(() => second.useScheduleLegendCollapsed());
    expect(nextLoad.current.collapsed).toBe(true);
  });

  it('the toolbar button mounting before task data loads does not close the panel it has not shown yet (#3614)', async () => {
    // Reproduces the real defect: `ScheduleLegendToggle` mounts (and reads
    // `getSnapshot()`) well before `ScheduleLegend` exists, because the
    // legend is gated on `visibleTasks.length > 0` and task data is fetched
    // async. The toolbar button alone must never mark the legend "seen", and
    // its early read must not poison the cached default for the legend that
    // mounts moments later in the SAME session.
    const mod = await freshModule();
    const { result: toolbar } = renderHook(() => mod.useScheduleLegendCollapsed());
    expect(toolbar.current.collapsed).toBe(false);
    expect(localStorage.getItem(SEEN_KEY)).toBeNull();

    // Task data "arrives" later — the legend mounts open for the first time.
    const { result: panel } = renderHook(() => {
      const state = mod.useScheduleLegendCollapsed();
      mod.useMarkScheduleLegendSeen(!state.collapsed);
      return state;
    });
    expect(panel.current.collapsed).toBe(false);
  });
});

describe('useLegendDefaultClosedInDemo (#4067)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('closes the first-visit default in a demo, but an explicit stored choice still wins', async () => {
    const m = await freshModule();
    const { result } = renderHook(() => {
      m.useLegendDefaultClosedInDemo(true);
      return m.useScheduleLegendCollapsed();
    });
    expect(result.current.collapsed).toBe(true);
    act(() => result.current.setCollapsed(false));
    expect(result.current.collapsed).toBe(false);
  });

  it('leaves the open-on-first-visit default alone on a normal install', async () => {
    const m = await freshModule();
    const { result } = renderHook(() => {
      m.useLegendDefaultClosedInDemo(false);
      return m.useScheduleLegendCollapsed();
    });
    expect(result.current.collapsed).toBe(false);
  });
});
