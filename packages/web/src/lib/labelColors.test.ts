import { describe, expect, it } from 'vitest';
import {
  LABEL_COLOR_KEYS,
  LABEL_COLOR_LABEL,
  labelDotStyle,
  labelTokenStyle,
  toLabelColorKey,
} from './labelColors';

describe('labelColors (ADR-0400)', () => {
  it('exposes the 8-key categorical palette with human names', () => {
    expect(LABEL_COLOR_KEYS).toHaveLength(8);
    for (const key of LABEL_COLOR_KEYS) {
      expect(LABEL_COLOR_LABEL[key]).toBeTruthy();
    }
  });

  it('narrows a known key and falls back to slate for unknown/empty values', () => {
    expect(toLabelColorKey('teal')).toBe('teal');
    expect(toLabelColorKey('not-a-color')).toBe('slate');
    expect(toLabelColorKey(null)).toBe('slate');
    expect(toLabelColorKey(undefined)).toBe('slate');
  });

  it('maps a key to theme-aware CSS custom-property tokens (never a raw hex)', () => {
    const style = labelTokenStyle('purple');
    expect(style.backgroundColor).toBe('var(--label-purple-bg)');
    expect(style.color).toBe('var(--label-purple-text)');
    expect(style.borderColor).toBe('var(--label-purple-border)');
  });

  it('routes an unknown color through the slate fallback tokens', () => {
    expect(labelTokenStyle('bogus').backgroundColor).toBe('var(--label-slate-bg)');
  });

  it('dot style uses the strong -text hue', () => {
    expect(labelDotStyle('rose').backgroundColor).toBe('var(--label-rose-text)');
  });
});
