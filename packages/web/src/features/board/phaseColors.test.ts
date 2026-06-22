/**
 * Tests for the deterministic per-phase color rail (#784).
 *
 * The board renders phase rails by hashing the phase id into a fixed palette;
 * the contract that matters downstream is determinism (the same phase keeps its
 * color across renders and reloads) and that the result is always a real
 * palette entry — a hash bug that returned undefined would paint a transparent
 * rail. The palette is pinned here so a silent reorder/trim is caught.
 */
import { describe, expect, it } from 'vitest';
import { phaseColor } from './phaseColors';

const PALETTE = [
  '#3E8C6D',
  '#E8A020',
  '#3B82F6',
  '#8B5CF6',
  '#EC4899',
  '#14B8A6',
  '#F97316',
  '#64748B',
];

describe('phaseColor', () => {
  it('is deterministic for a given id', () => {
    expect(phaseColor('design')).toBe(phaseColor('design'));
    expect(phaseColor('a-uuid-1234')).toBe(phaseColor('a-uuid-1234'));
  });

  it('always returns a member of the rail palette', () => {
    for (const id of ['design', 'build', 'test', 'release', '', 'x', 'phase-42']) {
      expect(PALETTE).toContain(phaseColor(id));
    }
  });

  it('returns a valid 6-digit hex color', () => {
    expect(phaseColor('anything')).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it('handles the empty string (hash 0 → first palette entry)', () => {
    expect(phaseColor('')).toBe(PALETTE[0]);
  });

  it('spreads distinct ids across more than one palette entry', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `phase-${i}`);
    const distinct = new Set(ids.map(phaseColor));
    expect(distinct.size).toBeGreaterThan(1);
  });
});
