import { describe, it, expect } from 'vitest';
import { cellColor } from './cellColor';

describe('cellColor', () => {
  it('returns surface-sunken for 0%', () => {
    const c = cellColor(0);
    expect(c.bg).toBe('var(--neutral-surface-sunken)');
    expect(c.fg).toBe('var(--neutral-text-disabled)');
    expect(c.border).toBeUndefined();
  });

  it('returns green ramp for 50% with primary text', () => {
    const c = cellColor(50);
    expect(c.bg).toMatch(/rgba\(28, 107, 58/);
    expect(c.fg).toBe('var(--neutral-text-primary)');
    expect(c.border).toBeUndefined();
  });

  it('returns white text at 80% (t=0.8 > 0.65)', () => {
    const c = cellColor(80);
    expect(c.fg).toBe('#fff');
  });

  it('returns full green at 100% with white text', () => {
    const c = cellColor(100);
    expect(c.bg).toMatch(/rgba\(28, 107, 58/);
    expect(c.fg).toBe('#fff');
    expect(c.border).toBeUndefined();
  });

  it('returns red ramp with critical border at 101%', () => {
    const c = cellColor(101);
    expect(c.bg).toMatch(/rgba\(185, 28, 28/);
    expect(c.border).toBe('1px solid var(--semantic-critical)');
    // 101% → util=1 over 100 → t=1/30 ≈ 0.033 → fg still primary
    expect(c.fg).toBe('var(--neutral-text-primary)');
  });

  it('returns white text above 110%', () => {
    const c = cellColor(111);
    expect(c.fg).toBe('#fff');
    expect(c.border).toBe('1px solid var(--semantic-critical)');
  });

  it('caps red alpha at 0.70 for very high values (120%+)', () => {
    const c120 = cellColor(120);
    const c200 = cellColor(200);
    // t is clamped to 1 at 130%, so both 120 and 200 should use same formula
    const alphaAt120 = 0.15 + Math.min(1, (120 - 100) / 30) * 0.55;
    expect(c120.bg).toContain(alphaAt120.toFixed(3));
    // 200% should clamp to t=1
    const alphaAt200 = (0.15 + 1 * 0.55).toFixed(3);
    expect(c200.bg).toContain(alphaAt200);
  });
});
