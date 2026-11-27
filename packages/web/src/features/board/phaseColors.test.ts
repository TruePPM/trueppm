/**
 * Tests for the deterministic per-phase color rail (#784).
 *
 * The board renders phase rails by hashing the phase id into a fixed palette;
 * the contract that matters downstream is determinism (the same phase keeps its
 * color across renders and reloads) and that the result is always a real
 * palette entry — a hash bug that returned undefined would paint a transparent
 * rail.
 */
import { describe, expect, it } from 'vitest';
import { phaseColor, RAIL_PALETTE } from './phaseColors';

describe('phaseColor', () => {
  // Pinned: appending a swatch to the shared set must not recolor existing rails.
  it('hashes over its own fixed list', () => {
    expect(RAIL_PALETTE).toEqual([
      '#3E8C6D',
      '#C17A10',
      '#7C3AED',
      '#0EA5E9',
      '#16A34A',
      '#3B82F6',
      '#A855F7',
    ]);
  });

  it('never returns a red or a gray', () => {
    const redsAndGrays = ['#DC2626', '#EF4444', '#6B6965', '#94A3B8', '#64748B'];
    const reachable = new Set(Array.from({ length: 500 }, (_, i) => phaseColor(`phase-${i}`)));
    expect(reachable.size).toBe(RAIL_PALETTE.length);
    for (const color of reachable) expect(redsAndGrays).not.toContain(color);
  });

  it('is deterministic for a given id', () => {
    expect(phaseColor('design')).toBe(phaseColor('design'));
    expect(phaseColor('a-uuid-1234')).toBe(phaseColor('a-uuid-1234'));
  });

  it('always returns a member of the rail palette', () => {
    for (const id of ['design', 'build', 'test', 'release', '', 'x', 'phase-42']) {
      expect(RAIL_PALETTE).toContain(phaseColor(id));
    }
  });

  it('returns a valid 6-digit hex color', () => {
    expect(phaseColor('anything')).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it('handles the empty string (hash 0 → first palette entry)', () => {
    expect(phaseColor('')).toBe(RAIL_PALETTE[0]);
  });

  it('spreads distinct ids across more than one palette entry', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `phase-${i}`);
    const distinct = new Set(ids.map(phaseColor));
    expect(distinct.size).toBeGreaterThan(1);
  });
});
