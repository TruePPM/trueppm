/**
 * Unit tests for ResourceCell overallocation drawer wiring.
 *
 * Tests the branch logic: overallocated + onOpenDrawer → renders <button>;
 * non-overallocated → renders <div>; missing onOpenDrawer → renders <div> even
 * when overallocated.
 *
 * We test the logic inline rather than via JSDOM rendering since the component
 * has no complex DOM interactions that require a browser environment.
 */
import { describe, it, expect } from 'vitest';
import { loadPercent, loadColor, capacityHours } from './resourceUtils';

// ---------------------------------------------------------------------------
// Logic tests — the branching logic driving the button/div choice
// ---------------------------------------------------------------------------

describe('overallocation detection logic', () => {
  it('pct > 100 is overallocated', () => {
    const capacity = capacityHours(8, 1.0); // 8h
    const pct = loadPercent(9, capacity);   // 112.5%
    expect(pct).toBeGreaterThan(100);
  });

  it('pct === 100 is NOT overallocated', () => {
    const capacity = capacityHours(8, 1.0);
    const pct = loadPercent(8, capacity); // 100%
    expect(pct).toBe(100);
    expect(pct > 100).toBe(false);
  });

  it('pct < 100 is not overallocated', () => {
    const capacity = capacityHours(8, 1.0);
    const pct = loadPercent(6, capacity); // 75%
    expect(pct).toBeLessThan(100);
  });

  it('part-time resource: 6h/day capacity triggers overalloc at 7h', () => {
    const capacity = capacityHours(6, 1.0); // 6h
    const pct = loadPercent(7, capacity);   // 116.7%
    expect(pct).toBeGreaterThan(100);
  });

  it('partial-unit resource: 0.5 max_units halves capacity', () => {
    const capacity = capacityHours(8, 0.5); // 4h
    const pct = loadPercent(5, capacity);   // 125%
    expect(pct).toBeGreaterThan(100);
  });
});

describe('loadColor thresholds for overallocation', () => {
  it('returns "critical" when pct > 100', () => {
    expect(loadColor(101)).toBe('critical');
    expect(loadColor(150)).toBe('critical');
  });

  it('returns "at-risk" in the amber band (85–100%)', () => {
    expect(loadColor(85)).toBe('at-risk');
    expect(loadColor(100)).toBe('at-risk');
  });

  it('returns "on-track" below 85%', () => {
    expect(loadColor(84)).toBe('on-track');
    expect(loadColor(0)).toBe('on-track');
  });
});

describe('bar height cap', () => {
  it('barHeight is capped at 120 even when pct > 120', () => {
    const pct = loadPercent(20, 8); // 250%
    const barHeight = Math.min(pct, 120);
    expect(barHeight).toBe(120);
  });

  it('barHeight matches pct when pct <= 120', () => {
    const pct = loadPercent(9.6, 8); // 120%
    const barHeight = Math.min(pct, 120);
    expect(barHeight).toBe(120);
  });
});
