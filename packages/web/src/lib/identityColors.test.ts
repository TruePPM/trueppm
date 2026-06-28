import { describe, it, expect } from 'vitest';
import {
  IDENTITY_AMBER,
  IDENTITY_SAGE,
  IDENTITY_VIOLET,
  IDENTITY_SWATCHES,
  tintedChipStyle,
} from './identityColors';

describe('identityColors', () => {
  it('tintedChipStyle returns a 10% wash background behind solid accent text', () => {
    // `1a` is the 8-bit alpha for ~10% — the inline-style equivalent of the
    // prior `bg-[hex]/10 text-[hex]` role-chip treatment.
    expect(tintedChipStyle('#7C3AED')).toEqual({
      backgroundColor: '#7C3AED1a',
      color: '#7C3AED',
    });
  });

  it('exposes stable named identity hues', () => {
    expect(IDENTITY_VIOLET).toBe('#7C3AED');
    expect(IDENTITY_SAGE).toBe('#3E8C6D');
    expect(IDENTITY_AMBER).toBe('#C17A10');
  });

  it('the shared swatch palette is six distinct hues including the named ones', () => {
    expect(IDENTITY_SWATCHES).toHaveLength(6);
    expect(new Set(IDENTITY_SWATCHES).size).toBe(6);
    expect(IDENTITY_SWATCHES).toContain(IDENTITY_SAGE);
    expect(IDENTITY_SWATCHES).toContain(IDENTITY_AMBER);
    expect(IDENTITY_SWATCHES).toContain(IDENTITY_VIOLET);
  });

  it('every swatch is a valid 6-digit hex so inline-style backgrounds render', () => {
    for (const hex of IDENTITY_SWATCHES) {
      expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});
