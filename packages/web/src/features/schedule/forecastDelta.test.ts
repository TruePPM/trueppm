import { describe, it, expect } from 'vitest';
import { formatDelta, deltaToneClass, fmtForecastDate } from './forecastDelta';

describe('formatDelta', () => {
  it('returns null for null/undefined (baseline / missing percentile)', () => {
    expect(formatDelta(null)).toBeNull();
    expect(formatDelta(undefined)).toBeNull();
  });

  it('formats an unchanged delta', () => {
    const d = formatDelta(0);
    expect(d).toEqual({ text: '0d', glyph: '◆', tone: 'neutral', aria: 'unchanged' });
  });

  it('formats a slip (later = worse) with + sign, up glyph, slip tone', () => {
    const d = formatDelta(14);
    expect(d?.text).toBe('+14d');
    expect(d?.glyph).toBe('▲');
    expect(d?.tone).toBe('slip');
    expect(d?.aria).toBe('slipped 14 days later');
  });

  it('formats an earlier pull (better) with minus sign, down glyph, earlier tone', () => {
    const d = formatDelta(-5);
    expect(d?.text).toBe('−5d'); // true minus sign U+2212
    expect(d?.glyph).toBe('▼');
    expect(d?.tone).toBe('earlier');
    expect(d?.aria).toBe('pulled 5 days earlier');
  });

  it('uses singular "day" for a one-day delta', () => {
    expect(formatDelta(1)?.aria).toBe('slipped 1 day later');
    expect(formatDelta(-1)?.aria).toBe('pulled 1 day earlier');
  });
});

describe('deltaToneClass', () => {
  it('maps tones to brand semantic color tokens', () => {
    expect(deltaToneClass('slip')).toBe('text-semantic-at-risk');
    expect(deltaToneClass('earlier')).toBe('text-semantic-on-track');
    expect(deltaToneClass('neutral')).toBe('text-neutral-text-secondary');
  });
});

describe('fmtForecastDate', () => {
  it('renders an em dash for null/empty', () => {
    expect(fmtForecastDate(null)).toBe('—');
    expect(fmtForecastDate(undefined)).toBe('—');
  });

  it('formats an ISO date as a short US date', () => {
    expect(fmtForecastDate('2026-09-15')).toMatch(/Sep 1[45], 2026/); // tz-tolerant
  });
});
