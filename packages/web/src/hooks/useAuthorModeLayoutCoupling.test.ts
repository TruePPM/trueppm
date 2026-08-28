import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAuthorModeLayoutCoupling } from './useAuthorModeLayoutCoupling';
import type { ScheduleAuthorMode } from './useScheduleAuthorMode';
import type { ScheduleViewMode } from '@/stores/scheduleStore';

/**
 * Drive the hook the way `ScheduleView` does: `viewMode` is real state that the
 * hook's own `setViewMode` writes back to, so a forced switch is visible on the
 * next render exactly as it is in the app. A test that passed a fixed
 * `viewMode` and only spied on `setViewMode` would never exercise rule 3, which
 * depends entirely on what the *next* render observes.
 */
function setup(initial: {
  authorMode: ScheduleAuthorMode;
  viewMode: ScheduleViewMode;
  isMobile?: boolean;
  isLoading?: boolean;
}) {
  const state = {
    authorMode: initial.authorMode,
    viewMode: initial.viewMode,
    isMobile: initial.isMobile ?? false,
    isLoading: initial.isLoading ?? false,
  };
  const setViewMode = vi.fn((next: ScheduleViewMode) => {
    state.viewMode = next;
  });

  const { rerender } = renderHook(() =>
    useAuthorModeLayoutCoupling({ ...state, setViewMode }),
  );

  return {
    setViewMode,
    get viewMode() {
      return state.viewMode;
    },
    /** Apply a change the way the app would, then let the hook observe it. */
    change(next: Partial<typeof state>) {
      act(() => {
        Object.assign(state, next);
        rerender();
      });
      // A `setViewMode` from the effect mutates `state` — render once more so
      // the hook sees the layout it just asked for, as it would in the app.
      act(() => rerender());
    },
  };
}

describe('useAuthorModeLayoutCoupling', () => {
  it('does nothing on mount — a stored Author mode is not a transition', () => {
    // The load-bearing one. Without it, every page load in Author mode would
    // overwrite the stored layout.
    const h = setup({ authorMode: 'author', viewMode: 'timeline' });
    expect(h.setViewMode).not.toHaveBeenCalled();
    expect(h.viewMode).toBe('timeline');
  });

  it('switches to Grid on entering Author', () => {
    const h = setup({ authorMode: 'read', viewMode: 'timeline' });
    h.change({ authorMode: 'author' });
    expect(h.viewMode).toBe('grid');
  });

  it('restores the previous layout on returning to Read', () => {
    const h = setup({ authorMode: 'read', viewMode: 'timeline' });
    h.change({ authorMode: 'author' });
    expect(h.viewMode).toBe('grid');
    h.change({ authorMode: 'read' });
    expect(h.viewMode).toBe('timeline');
  });

  it('never switches when the person was already in Grid', () => {
    // Read(Grid) -> Author -> Read must be silent throughout. A restore that
    // fired here would be a visible flicker for no reason.
    const h = setup({ authorMode: 'read', viewMode: 'grid' });
    h.change({ authorMode: 'author' });
    h.change({ authorMode: 'read' });
    expect(h.setViewMode).not.toHaveBeenCalled();
    expect(h.viewMode).toBe('grid');
  });

  it('lets a manual choice during Author survive the return to Read', () => {
    // Rule 3. The coupling fires on the transition; it is not a standing
    // override, and it must not undo a deliberate act.
    //
    // Start in GRID on purpose. The obvious phrasing — start in Timeline, get
    // forced to Grid, then manually pick Timeline back — cannot fail: the
    // remembered layout and the manual choice are both 'timeline', so
    // remembering and forgetting produce the same screen. Starting in Grid makes
    // the remembered value ('grid') differ from the manual choice ('timeline'),
    // which is the only shape that can tell the two behaviours apart.
    const h = setup({ authorMode: 'read', viewMode: 'grid' });
    h.change({ authorMode: 'author' });
    h.change({ viewMode: 'timeline' }); // the person picks Timeline themselves
    h.change({ authorMode: 'read' });
    expect(h.viewMode).toBe('timeline'); // NOT restored to the remembered 'grid'
  });

  it('re-arms on the next Author transition after a manual choice', () => {
    // Forgetting the remembered layout must not disable the coupling — the next
    // transition is a fresh decision.
    const h = setup({ authorMode: 'read', viewMode: 'grid' });
    h.change({ authorMode: 'author' });
    h.change({ viewMode: 'timeline' });
    h.change({ authorMode: 'read' });
    expect(h.viewMode).toBe('timeline');
    h.change({ authorMode: 'author' });
    expect(h.viewMode).toBe('grid');
  });

  it('does not touch the stored layout on mobile', () => {
    // `resolveEffectiveViewMode` already forces Timeline below `md` WITHOUT
    // writing it. Writing Grid here would corrupt the layout this same person
    // sees when they next open a desktop.
    const h = setup({ authorMode: 'read', viewMode: 'timeline', isMobile: true });
    h.change({ authorMode: 'author' });
    expect(h.setViewMode).not.toHaveBeenCalled();
    expect(h.viewMode).toBe('timeline');
  });

  it('waits for the stored preference to resolve before treating anything as a transition', () => {
    // Mounting mid-hydration must not read `read -> author` off the default.
    const h = setup({ authorMode: 'read', viewMode: 'timeline', isLoading: true });
    h.change({ authorMode: 'author', isLoading: true });
    expect(h.setViewMode).not.toHaveBeenCalled();
    // Once resolved, the first settled pass is still only a baseline.
    h.change({ isLoading: false });
    expect(h.setViewMode).not.toHaveBeenCalled();
    expect(h.viewMode).toBe('timeline');
  });
});
