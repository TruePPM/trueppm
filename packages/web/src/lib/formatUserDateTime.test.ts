import { describe, it, expect } from 'vitest';
import {
  formatInstant,
  formatInstantDate,
  formatInstantTime,
  resolveUserDatePrefs,
  type ResolvedDatePrefs,
} from './formatUserDateTime';

const NY: ResolvedDatePrefs = { timeZone: 'America/New_York', dateFormat: 'us' };
const TOKYO_EU: ResolvedDatePrefs = { timeZone: 'Asia/Tokyo', dateFormat: 'eu' };
const UTC_ISO: ResolvedDatePrefs = { timeZone: 'UTC', dateFormat: 'iso' };

describe('resolveUserDatePrefs', () => {
  it('resolves "auto" timezone to a concrete browser zone', () => {
    const { timeZone } = resolveUserDatePrefs('auto', 'auto');
    // In the jsdom/node test env this is a real IANA id (never "auto"/empty).
    expect(timeZone).toBeTruthy();
    expect(timeZone).not.toBe('auto');
  });

  it('passes an explicit timezone + format through', () => {
    expect(resolveUserDatePrefs('Asia/Tokyo', 'eu')).toEqual({
      timeZone: 'Asia/Tokyo',
      dateFormat: 'eu',
    });
  });

  it('treats null/undefined as auto', () => {
    const { dateFormat } = resolveUserDatePrefs(null, null);
    expect(dateFormat).toBe('auto');
  });
});

describe('formatInstantDate — re-clocks to the user timezone', () => {
  it('shifts the calendar day when the instant crosses midnight in the target zone', () => {
    // 02:00Z on Aug 19 is 22:00 on Aug 18 in New York → the DATE re-clocks to the 18th.
    expect(formatInstantDate('2026-08-19T02:00:00Z', NY)).toBe('August 18, 2026');
  });

  it('applies the ISO style, UTC zone', () => {
    expect(formatInstantDate('2026-08-19T12:00:00Z', UTC_ISO)).toBe('2026-08-19');
  });

  it('applies the EU style in the Tokyo zone', () => {
    // 12:00Z on Aug 19 is 21:00 on Aug 19 in Tokyo → still the 19th, EU order.
    expect(formatInstantDate('2026-08-19T12:00:00Z', TOKYO_EU)).toBe('19 August 2026');
  });
});

describe('formatInstantTime — time-of-day in the user timezone', () => {
  it('renders the local wall-clock time in the target zone', () => {
    // 02:00Z is 22:00 in New York (EDT, -04:00).
    expect(formatInstantTime('2026-08-19T02:00:00Z', NY)).toBe('10:00 PM');
  });
});

describe('formatInstant — date + time together', () => {
  it('composes a re-clocked date and time', () => {
    const out = formatInstant('2026-08-19T02:00:00Z', NY);
    expect(out).toContain('Aug 18, 2026');
    expect(out).toContain('10:00');
  });

  it('renders ISO instants as YYYY-MM-DD + 24h time', () => {
    expect(formatInstant('2026-08-19T09:05:00Z', UTC_ISO)).toBe('2026-08-19, 09:05');
  });
});

describe('empty / invalid handling', () => {
  it('returns an em-dash for empty input', () => {
    expect(formatInstant(null, NY)).toBe('—');
    expect(formatInstantDate(undefined, NY)).toBe('—');
    expect(formatInstantTime('', NY)).toBe('—');
  });

  it('returns the raw input when non-empty but unparseable', () => {
    expect(formatInstant('not-a-date', NY)).toBe('not-a-date');
  });
});
