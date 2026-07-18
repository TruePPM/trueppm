import { describe, expect, it } from 'vitest';
import {
  formatStoryPoints,
  isOversizedForScale,
  pointInputOptions,
  scalePoints,
  storyPointsUnit,
} from './storyPoints';

describe('scalePoints', () => {
  it('returns the numeric Fibonacci ladder', () => {
    expect(scalePoints('fibonacci').map((o) => o.value)).toEqual([1, 2, 3, 5, 8, 13, 21]);
    expect(scalePoints('fibonacci').every((o) => o.label === String(o.value))).toBe(true);
  });

  it('returns the linear 1-10 ladder', () => {
    expect(scalePoints('linear').map((o) => o.value)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('returns T-shirt labels mapped to their integers, in size order', () => {
    expect(scalePoints('tshirt')).toEqual([
      { value: 1, label: 'XS' },
      { value: 2, label: 'S' },
      { value: 3, label: 'M' },
      { value: 5, label: 'L' },
      { value: 8, label: 'XL' },
    ]);
  });
});

describe('formatStoryPoints', () => {
  it('renders the raw number for numeric scales', () => {
    expect(formatStoryPoints(5, 'fibonacci')).toBe('5');
    expect(formatStoryPoints(7, 'linear')).toBe('7');
  });

  it('renders the T-shirt label for an on-scale T-shirt value', () => {
    expect(formatStoryPoints(3, 'tshirt')).toBe('M');
    expect(formatStoryPoints(8, 'tshirt')).toBe('XL');
  });

  it('renders an off-scale T-shirt value as its raw number (never blank)', () => {
    // 7 is not in the T-shirt map (XS1,S2,M3,L5,XL8) — must still show.
    expect(formatStoryPoints(7, 'tshirt')).toBe('7');
  });

  it('renders an off-scale Fibonacci value as its raw number', () => {
    expect(formatStoryPoints(4, 'fibonacci')).toBe('4');
  });

  it('renders null as empty string', () => {
    expect(formatStoryPoints(null, 'fibonacci')).toBe('');
    expect(formatStoryPoints(null, 'tshirt')).toBe('');
  });
});

describe('storyPointsUnit', () => {
  it('is " pts" for numeric scales', () => {
    expect(storyPointsUnit(5, 'fibonacci')).toBe(' pts');
    expect(storyPointsUnit(3, 'linear')).toBe(' pts');
  });

  it('is "" for an on-scale T-shirt value (the size label stands alone)', () => {
    expect(storyPointsUnit(3, 'tshirt')).toBe('');
  });

  it('is " pts" for an off-scale T-shirt value (rendered as a number)', () => {
    expect(storyPointsUnit(7, 'tshirt')).toBe(' pts');
  });
});

describe('isOversizedForScale', () => {
  it('flags >= 8 on numeric scales', () => {
    expect(isOversizedForScale(8, 'fibonacci')).toBe(true);
    expect(isOversizedForScale(5, 'fibonacci')).toBe(false);
    expect(isOversizedForScale(10, 'linear')).toBe(true);
  });

  it('flags L/XL (>= 5) on T-shirt', () => {
    expect(isOversizedForScale(5, 'tshirt')).toBe(true); // L
    expect(isOversizedForScale(3, 'tshirt')).toBe(false); // M
  });

  it('is false for null', () => {
    expect(isOversizedForScale(null, 'fibonacci')).toBe(false);
  });
});

describe('pointInputOptions', () => {
  it('lists the on-scale options with no off-scale entry when the value is on-scale', () => {
    const opts = pointInputOptions('fibonacci', 5);
    expect(opts.map((o) => o.value)).toEqual([1, 2, 3, 5, 8, 13, 21]);
    expect(opts.some((o) => o.offScale)).toBe(false);
  });

  it('appends a preserved off-scale option when the value is off-scale', () => {
    const opts = pointInputOptions('fibonacci', 4);
    const off = opts.find((o) => o.offScale);
    expect(off).toEqual({ value: 4, label: '(4)', offScale: true });
    // The off-scale entry is last so the scale ladder stays intact.
    expect(opts[opts.length - 1]).toEqual(off);
  });

  it('appends an off-scale entry for a T-shirt project holding a legacy 7', () => {
    const opts = pointInputOptions('tshirt', 7);
    expect(opts.map((o) => o.label)).toEqual(['XS', 'S', 'M', 'L', 'XL', '(7)']);
    expect(opts.find((o) => o.value === 7)?.offScale).toBe(true);
  });

  it('adds no off-scale entry for a null value', () => {
    expect(pointInputOptions('tshirt', null).some((o) => o.offScale)).toBe(false);
  });
});
