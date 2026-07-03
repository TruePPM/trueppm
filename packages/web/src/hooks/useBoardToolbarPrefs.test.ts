import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';
import { useBoardToolbarPrefs, resolveBoardLayout } from './useBoardToolbarPrefs';

describe('useBoardToolbarPrefs', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to rail layout and comfortable backlog density', () => {
    const { result } = renderHook(() => useBoardToolbarPrefs());
    expect(result.current.layout).toBe('rail');
    expect(result.current.backlogDensity).toBe('comfortable');
  });

  it('persists layout selection to localStorage', () => {
    const { result } = renderHook(() => useBoardToolbarPrefs());
    act(() => result.current.setLayout('drawer'));
    expect(result.current.layout).toBe('drawer');
    const stored = JSON.parse(
      localStorage.getItem('trueppm.board.toolbarPrefs.v1') ?? '{}',
    ) as { layout?: string; backlogDensity?: string };
    expect(stored.layout).toBe('drawer');
  });

  it('persists backlog density to localStorage', () => {
    const { result } = renderHook(() => useBoardToolbarPrefs());
    act(() => result.current.setBacklogDensity('full'));
    expect(result.current.backlogDensity).toBe('full');
    const stored = JSON.parse(
      localStorage.getItem('trueppm.board.toolbarPrefs.v1') ?? '{}',
    ) as { layout?: string; backlogDensity?: string };
    expect(stored.backlogDensity).toBe('full');
  });

  it('restores layout and density across reloads (acceptance criterion)', () => {
    localStorage.setItem(
      'trueppm.board.toolbarPrefs.v1',
      JSON.stringify({ layout: 'queue', backlogDensity: 'compact' }),
    );
    const { result } = renderHook(() => useBoardToolbarPrefs());
    expect(result.current.layout).toBe('queue');
    expect(result.current.backlogDensity).toBe('compact');
  });

  it('falls back to defaults on malformed JSON in localStorage', () => {
    localStorage.setItem('trueppm.board.toolbarPrefs.v1', '{not json');
    const { result } = renderHook(() => useBoardToolbarPrefs());
    expect(result.current.layout).toBe('rail');
    expect(result.current.backlogDensity).toBe('comfortable');
  });

  it('falls back to defaults on unknown enum values in stored prefs', () => {
    localStorage.setItem(
      'trueppm.board.toolbarPrefs.v1',
      JSON.stringify({ layout: 'mosaic', backlogDensity: 'jumbo' }),
    );
    const { result } = renderHook(() => useBoardToolbarPrefs());
    expect(result.current.layout).toBe('rail');
    expect(result.current.backlogDensity).toBe('comfortable');
  });

  // Board zoom (issue 379) — additive third axis on the same v1 blob.
  it('defaults zoom to normal', () => {
    const { result } = renderHook(() => useBoardToolbarPrefs());
    expect(result.current.zoom).toBe('normal');
  });

  it('persists zoom selection to localStorage', () => {
    const { result } = renderHook(() => useBoardToolbarPrefs());
    act(() => result.current.setZoom('small'));
    expect(result.current.zoom).toBe('small');
    const stored = JSON.parse(
      localStorage.getItem('trueppm.board.toolbarPrefs.v1') ?? '{}',
    ) as { zoom?: string };
    expect(stored.zoom).toBe('small');
  });

  it('restores zoom across reloads', () => {
    localStorage.setItem(
      'trueppm.board.toolbarPrefs.v1',
      JSON.stringify({ layout: 'rail', backlogDensity: 'comfortable', zoom: 'large' }),
    );
    const { result } = renderHook(() => useBoardToolbarPrefs());
    expect(result.current.zoom).toBe('large');
  });

  it('defaults zoom to normal when the stored v1 blob predates the key (backwards-compat)', () => {
    localStorage.setItem(
      'trueppm.board.toolbarPrefs.v1',
      JSON.stringify({ layout: 'queue', backlogDensity: 'compact' }),
    );
    const { result } = renderHook(() => useBoardToolbarPrefs());
    expect(result.current.zoom).toBe('normal');
    // The other axes still restore — the additive key didn't disturb them.
    expect(result.current.layout).toBe('queue');
    expect(result.current.backlogDensity).toBe('compact');
  });

  it('falls back to normal zoom on an unknown stored value', () => {
    localStorage.setItem(
      'trueppm.board.toolbarPrefs.v1',
      JSON.stringify({ zoom: 'gigantic' }),
    );
    const { result } = renderHook(() => useBoardToolbarPrefs());
    expect(result.current.zoom).toBe('normal');
  });

  // Swimlane grouping (issue 324) — additive fourth axis on the same v1 blob.
  it('defaults groupBy to phase', () => {
    const { result } = renderHook(() => useBoardToolbarPrefs());
    expect(result.current.groupBy).toBe('phase');
  });

  it('persists groupBy selection to localStorage', () => {
    const { result } = renderHook(() => useBoardToolbarPrefs());
    act(() => result.current.setGroupBy('assignee'));
    expect(result.current.groupBy).toBe('assignee');
    const stored = JSON.parse(
      localStorage.getItem('trueppm.board.toolbarPrefs.v1') ?? '{}',
    ) as { groupBy?: string };
    expect(stored.groupBy).toBe('assignee');
  });

  it('restores groupBy across reloads', () => {
    localStorage.setItem(
      'trueppm.board.toolbarPrefs.v1',
      JSON.stringify({ layout: 'rail', backlogDensity: 'comfortable', groupBy: 'assignee' }),
    );
    const { result } = renderHook(() => useBoardToolbarPrefs());
    expect(result.current.groupBy).toBe('assignee');
  });

  it('persists and restores the epic groupBy mode (#364)', () => {
    const { result } = renderHook(() => useBoardToolbarPrefs());
    act(() => result.current.setGroupBy('epic'));
    expect(result.current.groupBy).toBe('epic');
    const stored = JSON.parse(localStorage.getItem('trueppm.board.toolbarPrefs.v1') ?? '{}') as {
      groupBy?: string;
    };
    expect(stored.groupBy).toBe('epic');
  });

  it('defaults groupBy to phase when the stored blob predates the key (backwards-compat)', () => {
    localStorage.setItem(
      'trueppm.board.toolbarPrefs.v1',
      JSON.stringify({ layout: 'queue', backlogDensity: 'compact', zoom: 'large' }),
    );
    const { result } = renderHook(() => useBoardToolbarPrefs());
    expect(result.current.groupBy).toBe('phase');
    // The other axes still restore — the additive key didn't disturb them.
    expect(result.current.zoom).toBe('large');
    expect(result.current.layout).toBe('queue');
  });

  it('falls back to phase groupBy on an unknown stored value', () => {
    localStorage.setItem('trueppm.board.toolbarPrefs.v1', JSON.stringify({ groupBy: 'team' }));
    const { result } = renderHook(() => useBoardToolbarPrefs());
    expect(result.current.groupBy).toBe('phase');
  });

  // Explicit-vs-never-set layout (issue 605). The board auto-defaults an
  // unset layout to Queue on mobile, so a never-set layout must be
  // distinguishable from an explicit 'rail'.
  describe('layoutExplicit (issue 605)', () => {
    it('is false when no preference has ever been stored', () => {
      const { result } = renderHook(() => useBoardToolbarPrefs());
      expect(result.current.layout).toBe('rail');
      expect(result.current.layoutExplicit).toBe(false);
    });

    it('is true once the user explicitly picks a layout', () => {
      const { result } = renderHook(() => useBoardToolbarPrefs());
      act(() => result.current.setLayout('rail'));
      expect(result.current.layoutExplicit).toBe(true);
    });

    it('stays false when only a sibling axis (density/zoom/groupBy) is changed', () => {
      const { result } = renderHook(() => useBoardToolbarPrefs());
      act(() => result.current.setBacklogDensity('full'));
      act(() => result.current.setZoom('large'));
      act(() => result.current.setGroupBy('assignee'));
      // The layout was never chosen — the persisted blob must not smuggle in a
      // 'rail' that would look explicit on the next read.
      expect(result.current.layoutExplicit).toBe(false);
      const stored = JSON.parse(
        localStorage.getItem('trueppm.board.toolbarPrefs.v1') ?? '{}',
      ) as { layout?: string };
      expect(stored.layout).toBeUndefined();
    });

    it('reads an explicit layout stored by a prior session as explicit', () => {
      localStorage.setItem(
        'trueppm.board.toolbarPrefs.v1',
        JSON.stringify({ layout: 'drawer', backlogDensity: 'comfortable' }),
      );
      const { result } = renderHook(() => useBoardToolbarPrefs());
      expect(result.current.layout).toBe('drawer');
      expect(result.current.layoutExplicit).toBe(true);
    });

    it('treats an unknown stored layout as never-set', () => {
      localStorage.setItem(
        'trueppm.board.toolbarPrefs.v1',
        JSON.stringify({ layout: 'mosaic', backlogDensity: 'full' }),
      );
      const { result } = renderHook(() => useBoardToolbarPrefs());
      expect(result.current.layout).toBe('rail');
      expect(result.current.layoutExplicit).toBe(false);
    });
  });
});

describe('resolveBoardLayout (issue 605)', () => {
  it('auto-defaults an unset layout to queue on mobile', () => {
    expect(resolveBoardLayout('rail', false, true)).toBe('queue');
  });

  it('keeps the desktop fallback (rail) when unset on desktop', () => {
    expect(resolveBoardLayout('rail', false, false)).toBe('rail');
  });

  it('preserves an explicit rail choice across the mobile breakpoint', () => {
    expect(resolveBoardLayout('rail', true, true)).toBe('rail');
  });

  it('preserves an explicit drawer choice across the mobile breakpoint', () => {
    expect(resolveBoardLayout('drawer', true, true)).toBe('drawer');
  });

  it('leaves an explicit queue choice unchanged on desktop', () => {
    expect(resolveBoardLayout('queue', true, false)).toBe('queue');
  });
});
