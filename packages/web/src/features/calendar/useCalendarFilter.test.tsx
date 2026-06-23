/**
 * useCalendarFilter — owner of the calendar's `calView` (week|month) and
 * `calAnchor` URL state. The regression-prone parts are the defaults (month
 * mode, today's anchor when the params are absent) and the month-vs-week
 * branch in `goNext`/`goPrev`, which delegates to different date helpers. State
 * lives in `useSearchParams`, so each case drives a `MemoryRouter` and reads
 * the resulting `calView` / `calAnchor` back off the URL.
 */

import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCalendarFilter } from './useCalendarFilter';

function setup(initialUrl = '/projects/p1/calendar') {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(MemoryRouter, { initialEntries: [initialUrl] }, children);
  }
  return renderHook(() => useCalendarFilter(), { wrapper: Wrapper });
}

describe('useCalendarFilter defaults', () => {
  beforeEach(() => {
    // Pin "today" so the today/anchor default is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T08:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to month mode when calView is absent', () => {
    const { result } = setup();
    expect(result.current.calView).toBe('month');
  });

  it("defaults the anchor to today's UTC date (YYYY-MM-DD) when calAnchor is absent", () => {
    const { result } = setup();
    expect(result.current.anchorIso).toBe('2026-03-15');
  });

  it('reads calView and calAnchor from the URL when present', () => {
    const { result } = setup('/calendar?calView=week&calAnchor=2026-01-05');
    expect(result.current.calView).toBe('week');
    expect(result.current.anchorIso).toBe('2026-01-05');
  });
});

describe('useCalendarFilter mutations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T08:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('setCalView switches the mode and preserves the anchor', () => {
    const { result } = setup('/calendar?calAnchor=2026-02-01');
    act(() => result.current.setCalView('week'));
    expect(result.current.calView).toBe('week');
    expect(result.current.anchorIso).toBe('2026-02-01');
  });

  it('goToToday resets the anchor to the current UTC date', () => {
    const { result } = setup('/calendar?calAnchor=2026-01-01');
    act(() => result.current.goToToday());
    expect(result.current.anchorIso).toBe('2026-03-15');
  });
});

describe('useCalendarFilter navigation — month mode', () => {
  it('goNext advances to the first of the next month', () => {
    const { result } = setup('/calendar?calView=month&calAnchor=2026-03-15');
    act(() => result.current.goNext());
    expect(result.current.anchorIso).toBe('2026-04-01');
  });

  it('goPrev retreats to the first of the prior month', () => {
    const { result } = setup('/calendar?calView=month&calAnchor=2026-03-15');
    act(() => result.current.goPrev());
    expect(result.current.anchorIso).toBe('2026-02-01');
  });

  it('goNext crosses the year boundary (Dec → Jan)', () => {
    const { result } = setup('/calendar?calView=month&calAnchor=2026-12-10');
    act(() => result.current.goNext());
    expect(result.current.anchorIso).toBe('2027-01-01');
  });

  it('goPrev crosses the year boundary (Jan → Dec)', () => {
    const { result } = setup('/calendar?calView=month&calAnchor=2026-01-20');
    act(() => result.current.goPrev());
    expect(result.current.anchorIso).toBe('2025-12-01');
  });
});

describe('useCalendarFilter navigation — week mode', () => {
  it('goNext advances the anchor by exactly 7 days', () => {
    const { result } = setup('/calendar?calView=week&calAnchor=2026-03-15');
    act(() => result.current.goNext());
    expect(result.current.anchorIso).toBe('2026-03-22');
  });

  it('goPrev retreats the anchor by exactly 7 days', () => {
    const { result } = setup('/calendar?calView=week&calAnchor=2026-03-15');
    act(() => result.current.goPrev());
    expect(result.current.anchorIso).toBe('2026-03-08');
  });

  it('goNext rolls a week forward across a month boundary', () => {
    const { result } = setup('/calendar?calView=week&calAnchor=2026-03-29');
    act(() => result.current.goNext());
    expect(result.current.anchorIso).toBe('2026-04-05');
  });
});
