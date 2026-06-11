/**
 * Tests for useResolveOverallocation hook.
 *
 * Tests the state machine: openDrawer sets target + isOpen + ariaMessage;
 * closeDrawer starts the close animation (isOpen=false, target stays briefly).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useResolveOverallocation } from './useResolveOverallocation';
import type { OverallocationTarget } from '@/features/resource/ResourceOverallocationDrawer';

const makeTarget = (overrides: Partial<OverallocationTarget> = {}): OverallocationTarget => ({
  resourceId: 'res-1',
  resourceName: 'Alice',
  iso: '2026-04-14',
  // load_pct/band/overallocated are server-owned (#989); the hook reads load_pct.
  entry: { hours: 10, tasks: ['task-a', 'task-b'], load_pct: 125, load_band: 'critical', overallocated: true },
  hoursPerDay: 8,
  maxUnits: 1.0,
  ...overrides,
});

describe('useResolveOverallocation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts closed with null target and empty ariaMessage', () => {
    const { result } = renderHook(() => useResolveOverallocation());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.target).toBeNull();
    expect(result.current.ariaMessage).toBe('');
  });

  it('openDrawer sets isOpen=true and target', () => {
    const { result } = renderHook(() => useResolveOverallocation());
    const target = makeTarget();

    act(() => { result.current.openDrawer(target); });

    expect(result.current.isOpen).toBe(true);
    expect(result.current.target).toStrictEqual(target);
  });

  it('openDrawer builds a human-readable ariaMessage with pct and overHours', () => {
    const { result } = renderHook(() => useResolveOverallocation());
    // 10h scheduled / 8h capacity = 125% (server load_pct), 2h over
    const target = makeTarget({
      entry: { hours: 10, tasks: [], load_pct: 125, load_band: 'critical', overallocated: true },
    });

    act(() => { result.current.openDrawer(target); });

    expect(result.current.ariaMessage).toMatch(/Alice/);
    expect(result.current.ariaMessage).toMatch(/125%/);
    expect(result.current.ariaMessage).toMatch(/2\.0h over capacity/);
    expect(result.current.ariaMessage).toMatch(/Drawer open/);
  });

  it('closeDrawer sets isOpen=false immediately', () => {
    const { result } = renderHook(() => useResolveOverallocation());

    act(() => { result.current.openDrawer(makeTarget()); });
    expect(result.current.isOpen).toBe(true);

    act(() => { result.current.closeDrawer(); });
    expect(result.current.isOpen).toBe(false);
  });

  it('target stays mounted for 250ms after closeDrawer (animation window)', () => {
    const { result } = renderHook(() => useResolveOverallocation());
    const target = makeTarget();

    act(() => { result.current.openDrawer(target); });
    act(() => { result.current.closeDrawer(); });

    // Still set at 0ms
    expect(result.current.target).toStrictEqual(target);

    // Cleared after 250ms
    act(() => { vi.advanceTimersByTime(250); });
    expect(result.current.target).toBeNull();
  });

  it('openDrawer on a part-time resource computes correct pct', () => {
    const { result } = renderHook(() => useResolveOverallocation());
    // 6h/day capacity (part-time), 9h scheduled → 150% (server load_pct), 3h over
    const target = makeTarget({
      hoursPerDay: 6,
      entry: { hours: 9, tasks: [], load_pct: 150, load_band: 'critical', overallocated: true },
    });

    act(() => { result.current.openDrawer(target); });

    expect(result.current.ariaMessage).toMatch(/150%/);
    expect(result.current.ariaMessage).toMatch(/3\.0h over capacity/);
  });

  it('overHours is 0 when not overallocated (clamp at 0)', () => {
    const { result } = renderHook(() => useResolveOverallocation());
    // 6h / 8h = 75% — not overallocated; overHours should be "0.0h"
    const target = makeTarget({
      entry: { hours: 6, tasks: [], load_pct: 75, load_band: 'on-track', overallocated: false },
    });

    act(() => { result.current.openDrawer(target); });

    expect(result.current.ariaMessage).toMatch(/0\.0h over capacity/);
  });
});
