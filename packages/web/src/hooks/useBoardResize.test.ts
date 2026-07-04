/**
 * useBoardResize unit tests (issue 285).
 *
 * Covers the two persisted board-resize hooks: per-column widths and per-phase
 * heights. Exercises the clamp-on-read (stale/hand-edited localStorage), the
 * clamp-on-write mutators, JSON-corruption fallback, quota-failure resilience,
 * and the clamp helpers themselves.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useBoardColumnWidths,
  useBoardPhaseHeights,
  clampBoardColumnWidth,
  clampBoardPhaseHeight,
  MIN_BOARD_COLUMN_WIDTH,
  MIN_BOARD_PHASE_HEIGHT,
} from './useBoardResize';

const COLUMN_WIDTHS_KEY = 'trueppm.board.columnWidths.v1';
const PHASE_HEIGHTS_KEY = 'trueppm.board.phaseHeights.v1';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('clamp helpers', () => {
  it('clamps a column width below the floor up to MIN_BOARD_COLUMN_WIDTH', () => {
    expect(clampBoardColumnWidth(10)).toBe(MIN_BOARD_COLUMN_WIDTH);
    expect(MIN_BOARD_COLUMN_WIDTH).toBe(200);
  });

  it('passes an above-floor column width through, rounded to a whole pixel', () => {
    expect(clampBoardColumnWidth(345.6)).toBe(346);
  });

  it('clamps a phase height below the floor up to MIN_BOARD_PHASE_HEIGHT', () => {
    expect(clampBoardPhaseHeight(30)).toBe(MIN_BOARD_PHASE_HEIGHT);
    expect(MIN_BOARD_PHASE_HEIGHT).toBe(120);
  });

  it('passes an above-floor phase height through, rounded to a whole pixel', () => {
    expect(clampBoardPhaseHeight(280.2)).toBe(280);
  });
});

describe('useBoardColumnWidths', () => {
  it('starts empty when localStorage has no persisted widths', () => {
    const { result } = renderHook(() => useBoardColumnWidths());
    expect(result.current.widths).toEqual({});
  });

  it('hydrates persisted widths, clamping any value below the floor', () => {
    localStorage.setItem(
      COLUMN_WIDTHS_KEY,
      JSON.stringify({ IN_PROGRESS: 320, REVIEW: 50 /* below MIN 200 */ }),
    );
    const { result } = renderHook(() => useBoardColumnWidths());
    expect(result.current.widths.IN_PROGRESS).toBe(320);
    expect(result.current.widths.REVIEW).toBe(MIN_BOARD_COLUMN_WIDTH);
  });

  it('drops non-numeric persisted entries', () => {
    localStorage.setItem(
      COLUMN_WIDTHS_KEY,
      JSON.stringify({ IN_PROGRESS: 'wide', REVIEW: 260 }),
    );
    const { result } = renderHook(() => useBoardColumnWidths());
    expect(result.current.widths.IN_PROGRESS).toBeUndefined();
    expect(result.current.widths.REVIEW).toBe(260);
  });

  it('returns an empty map when the persisted JSON is corrupt', () => {
    localStorage.setItem(COLUMN_WIDTHS_KEY, '{not json');
    const { result } = renderHook(() => useBoardColumnWidths());
    expect(result.current.widths).toEqual({});
  });

  it('setWidth clamps, updates state, and persists', () => {
    const { result } = renderHook(() => useBoardColumnWidths());
    act(() => result.current.setWidth('IN_PROGRESS', 40)); // below floor
    expect(result.current.widths.IN_PROGRESS).toBe(MIN_BOARD_COLUMN_WIDTH);

    act(() => result.current.setWidth('REVIEW', 400));
    expect(result.current.widths.REVIEW).toBe(400);

    const stored = JSON.parse(localStorage.getItem(COLUMN_WIDTHS_KEY) ?? '{}') as Record<
      string,
      number
    >;
    expect(stored.IN_PROGRESS).toBe(MIN_BOARD_COLUMN_WIDTH);
    expect(stored.REVIEW).toBe(400);
  });

  it('does not throw when persistence fails (quota / private mode)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { result } = renderHook(() => useBoardColumnWidths());
    expect(() => act(() => result.current.setWidth('REVIEW', 300))).not.toThrow();
    expect(result.current.widths.REVIEW).toBe(300); // state still updates
    spy.mockRestore();
  });
});

describe('useBoardPhaseHeights', () => {
  it('starts empty when localStorage has no persisted heights', () => {
    const { result } = renderHook(() => useBoardPhaseHeights());
    expect(result.current.heights).toEqual({});
  });

  it('hydrates persisted heights, clamping any value below the floor', () => {
    localStorage.setItem(
      PHASE_HEIGHTS_KEY,
      JSON.stringify({ 'phase-a': 300, 'phase-b': 40 /* below MIN 120 */ }),
    );
    const { result } = renderHook(() => useBoardPhaseHeights());
    expect(result.current.heights['phase-a']).toBe(300);
    expect(result.current.heights['phase-b']).toBe(MIN_BOARD_PHASE_HEIGHT);
  });

  it('setHeight clamps, updates state, and persists', () => {
    const { result } = renderHook(() => useBoardPhaseHeights());
    act(() => result.current.setHeight('phase-a', 60)); // below floor
    expect(result.current.heights['phase-a']).toBe(MIN_BOARD_PHASE_HEIGHT);

    act(() => result.current.setHeight('phase-a', 240));
    expect(result.current.heights['phase-a']).toBe(240);

    const stored = JSON.parse(localStorage.getItem(PHASE_HEIGHTS_KEY) ?? '{}') as Record<
      string,
      number
    >;
    expect(stored['phase-a']).toBe(240);
  });
});
