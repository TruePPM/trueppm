import { describe, it, expect } from 'vitest';
import { PROGRAM_ACCENT_SWATCHES, contrastText } from './programColor';

describe('contrastText', () => {
  it('returns white for dark accents', () => {
    expect(contrastText('#1C6B3A')).toBe('#FFFFFF'); // dark green
    expect(contrastText('#7C3AED')).toBe('#FFFFFF'); // violet
    expect(contrastText('#000000')).toBe('#FFFFFF');
  });

  it('returns near-black for light accents', () => {
    expect(contrastText('#FFFFFF')).toBe('#0F172A');
    expect(contrastText('#0EA5E9')).toBe('#0F172A'); // sky — light enough for dark text
  });

  it('falls back to white for malformed input', () => {
    expect(contrastText('not-a-color')).toBe('#FFFFFF');
    expect(contrastText('#abc')).toBe('#FFFFFF');
  });

  it('picks a defined foreground for every shipped swatch', () => {
    for (const swatch of PROGRAM_ACCENT_SWATCHES) {
      expect(['#FFFFFF', '#0F172A']).toContain(contrastText(swatch));
    }
  });
});
