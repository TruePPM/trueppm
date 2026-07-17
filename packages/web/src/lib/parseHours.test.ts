import { describe, it, expect } from 'vitest';
import { formatMinutesAsHm, parseHoursToMinutes, OVER_DAILY_MINUTES } from './parseHours';

describe('parseHoursToMinutes', () => {
  it('parses whole and decimal hours', () => {
    expect(parseHoursToMinutes('2')).toBe(120);
    expect(parseHoursToMinutes('2.5')).toBe(150);
    expect(parseHoursToMinutes('0.25')).toBe(15);
    expect(parseHoursToMinutes('.5')).toBe(30);
  });

  it('parses clock hours h:mm', () => {
    expect(parseHoursToMinutes('2:30')).toBe(150);
    expect(parseHoursToMinutes('0:15')).toBe(15);
    expect(parseHoursToMinutes('1:05')).toBe(65);
    expect(parseHoursToMinutes('1:5')).toBe(65);
  });

  it('treats blank as a cleared cell (0), distinct from invalid (null)', () => {
    expect(parseHoursToMinutes('')).toBe(0);
    expect(parseHoursToMinutes('   ')).toBe(0);
    expect(parseHoursToMinutes('0')).toBe(0);
  });

  it('accepts a bare trailing dot as the integer hours (e.g. "2.")', () => {
    expect(parseHoursToMinutes('2.')).toBe(120);
  });

  it('rejects unparseable input as null', () => {
    expect(parseHoursToMinutes('abc')).toBeNull();
    expect(parseHoursToMinutes('1:2:3')).toBeNull();
    expect(parseHoursToMinutes('1:75')).toBeNull(); // minutes > 59
    expect(parseHoursToMinutes('-2')).toBeNull();
  });

  it('rejects malformed decimal forms the unambiguous regex must exclude', () => {
    // These probe the `^(?:\d+(?:\.\d+)?|\.\d+)$` rewrite (SonarQube S5852).
    expect(parseHoursToMinutes('.')).toBeNull(); // dot with no digits
    expect(parseHoursToMinutes('1.2.3')).toBeNull(); // two dots
    expect(parseHoursToMinutes('..5')).toBeNull(); // leading double-dot
    expect(parseHoursToMinutes('1.')).toBe(60); // trailing dot is the integer 1
  });

  it('rejects out-of-range (> 24h) as null', () => {
    expect(parseHoursToMinutes('25')).toBeNull();
    expect(parseHoursToMinutes('24')).toBe(1440);
    expect(parseHoursToMinutes('24:01')).toBeNull();
  });
});

describe('formatMinutesAsHm', () => {
  it('formats minutes as h:mm', () => {
    expect(formatMinutesAsHm(150)).toBe('2:30');
    expect(formatMinutesAsHm(65)).toBe('1:05');
    expect(formatMinutesAsHm(0)).toBe('0:00');
    expect(formatMinutesAsHm(600)).toBe('10:00');
  });

  it('clamps non-finite / negative to 0:00', () => {
    expect(formatMinutesAsHm(-5)).toBe('0:00');
    expect(formatMinutesAsHm(NaN)).toBe('0:00');
  });
});

it('flags the 8h daily threshold', () => {
  expect(OVER_DAILY_MINUTES).toBe(480);
});
