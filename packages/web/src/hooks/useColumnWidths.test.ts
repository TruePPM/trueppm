/**
 * useColumnWidths unit tests (#784 coverage backfill).
 *
 * The hook persists Gantt task-list column widths + visibility in localStorage,
 * clamping widths to MIN_COL_WIDTHS and keeping the `task` column always visible.
 * These tests cover the load/clamp/parse-error paths, the setWidth/toggleColumn
 * mutators (including persistence + the always-visible task invariant), and the
 * visible-only totalWidth sum — none of which had coverage before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useColumnWidths, MIN_COL_WIDTHS, type ColumnKey } from './useColumnWidths';

const WIDTHS_KEY = 'trueppm.schedule.columnWidths.v5';
const VISIBILITY_KEY = 'trueppm.schedule.columnVisibility.v1';

// Defaults mirrored from the hook (kept in sync via the "matches defaults" test).
const DEFAULT_WIDTHS: Record<ColumnKey, number> = {
  wbs: 48,
  task: 220,
  dur: 52,
  start: 74,
  finish: 74,
  progress: 60,
  owner: 72,
};
const DEFAULT_TOTAL = Object.values(DEFAULT_WIDTHS).reduce((a, b) => a + b, 0);

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('useColumnWidths — initial load', () => {
  it('returns the built-in defaults when localStorage is empty', () => {
    const { result } = renderHook(() => useColumnWidths());
    expect(result.current.widths).toEqual(DEFAULT_WIDTHS);
    expect(result.current.totalWidth).toBe(DEFAULT_TOTAL);
    // All columns visible by default.
    expect(Object.values(result.current.visible).every(Boolean)).toBe(true);
  });

  it('hydrates persisted widths, clamping any value below its minimum', () => {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify({ task: 300, owner: 5 /* below MIN 40 */ }));
    const { result } = renderHook(() => useColumnWidths());
    expect(result.current.widths.task).toBe(300);
    expect(result.current.widths.owner).toBe(MIN_COL_WIDTHS.owner); // clamped up
    // Keys absent from storage fall back to their default.
    expect(result.current.widths.start).toBe(DEFAULT_WIDTHS.start);
  });

  it('falls back to the default for a non-numeric persisted width', () => {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify({ dur: 'wide' }));
    const { result } = renderHook(() => useColumnWidths());
    expect(result.current.widths.dur).toBe(DEFAULT_WIDTHS.dur);
  });

  it('falls back to all defaults when the persisted widths JSON is corrupt', () => {
    localStorage.setItem(WIDTHS_KEY, '{not valid json');
    const { result } = renderHook(() => useColumnWidths());
    expect(result.current.widths).toEqual(DEFAULT_WIDTHS);
  });

  it('respects persisted visibility but forces the task column visible', () => {
    localStorage.setItem(VISIBILITY_KEY, JSON.stringify({ task: false, owner: false, wbs: true }));
    const { result } = renderHook(() => useColumnWidths());
    expect(result.current.visible.task).toBe(true); // never hidable
    expect(result.current.visible.owner).toBe(false);
    expect(result.current.visible.wbs).toBe(true);
    // Unspecified keys default to visible.
    expect(result.current.visible.start).toBe(true);
  });

  it('falls back to default visibility when the visibility JSON is corrupt', () => {
    localStorage.setItem(VISIBILITY_KEY, 'nope');
    const { result } = renderHook(() => useColumnWidths());
    expect(Object.values(result.current.visible).every(Boolean)).toBe(true);
  });
});

describe('useColumnWidths — setWidth', () => {
  it('sets an above-minimum width and persists it', () => {
    const { result } = renderHook(() => useColumnWidths());
    act(() => result.current.setWidth('start', 120));
    expect(result.current.widths.start).toBe(120);
    const stored = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? '{}') as Partial<
      Record<ColumnKey, number>
    >;
    expect(stored.start).toBe(120);
  });

  it('clamps a below-minimum width up to the column minimum', () => {
    const { result } = renderHook(() => useColumnWidths());
    act(() => result.current.setWidth('task', 10)); // MIN 120
    expect(result.current.widths.task).toBe(MIN_COL_WIDTHS.task);
    const stored = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? '{}') as Partial<
      Record<ColumnKey, number>
    >;
    expect(stored.task).toBe(MIN_COL_WIDTHS.task);
  });

  it('does not throw when localStorage.setItem fails (quota / private mode)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { result } = renderHook(() => useColumnWidths());
    expect(() => act(() => result.current.setWidth('owner', 200))).not.toThrow();
    // State still updates even though persistence failed.
    expect(result.current.widths.owner).toBe(200);
    spy.mockRestore();
  });
});

describe('useColumnWidths — toggleColumn & totalWidth', () => {
  it('toggling the task column is a no-op (always visible, nothing persisted)', () => {
    const { result } = renderHook(() => useColumnWidths());
    act(() => result.current.toggleColumn('task'));
    expect(result.current.visible.task).toBe(true);
    expect(localStorage.getItem(VISIBILITY_KEY)).toBeNull();
  });

  it('hides a column, persists it, and drops totalWidth by that column width', () => {
    const { result } = renderHook(() => useColumnWidths());
    const before = result.current.totalWidth;
    const ownerWidth = result.current.widths.owner;

    act(() => result.current.toggleColumn('owner'));

    expect(result.current.visible.owner).toBe(false);
    expect(result.current.totalWidth).toBe(before - ownerWidth);
    const stored = JSON.parse(localStorage.getItem(VISIBILITY_KEY) ?? '{}') as Partial<
      Record<ColumnKey, boolean>
    >;
    expect(stored.owner).toBe(false);
  });

  it('toggling a hidden column back shows it again and restores totalWidth', () => {
    const { result } = renderHook(() => useColumnWidths());
    const original = result.current.totalWidth;
    act(() => result.current.toggleColumn('wbs'));
    act(() => result.current.toggleColumn('wbs'));
    expect(result.current.visible.wbs).toBe(true);
    expect(result.current.totalWidth).toBe(original);
  });

  it('totalWidth sums only visible columns', () => {
    localStorage.setItem(VISIBILITY_KEY, JSON.stringify({ owner: false, wbs: false }));
    const { result } = renderHook(() => useColumnWidths());
    const expected = (Object.keys(DEFAULT_WIDTHS) as ColumnKey[])
      .filter((k) => k !== 'owner' && k !== 'wbs')
      .reduce((sum, k) => sum + DEFAULT_WIDTHS[k], 0);
    expect(result.current.totalWidth).toBe(expected);
  });
});
