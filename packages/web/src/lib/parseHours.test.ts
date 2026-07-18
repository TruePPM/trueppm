import { describe, it, expect } from 'vitest';
import { formatMinutesAsHm, parseHoursToMinutes, OVER_DAILY_MINUTES } from './parseHours';

describe('parseHoursToMinutes', () => {
  it('parses whole and decimal hours', () => {
    expect(parseHoursToMinutes('2')).toBe(120);
    expect(parseHoursToMinutes('2.5')).toBe(150);
    expect(parseHoursToMinutes('0.25')).toBe(15);
    expect(parseHoursToMinutes('.5')).toBe(30);
  });

  it('accepts the decimal edge forms the (S5852-safe) parser allows', () => {
    // ".d", "d", "d.d", and a trailing-dot "d." are all valid; the rewrite from
    // `\d*\.?\d+` to disjoint alternatives must keep accepting exactly these.
    expect(parseHoursToMinutes('.25')).toBe(15);
    expect(parseHoursToMinutes('5.')).toBe(300); // trailing-dot form → 5h
    expect(parseHoursToMinutes('05')).toBe(300); // leading zero
    expect(parseHoursToMinutes('1.0')).toBe(60);
  });

  it('rejects malformed decimals (multiple/lone dots)', () => {
    expect(parseHoursToMinutes('1.2.3')).toBeNull();
    expect(parseHoursToMinutes('.')).toBeNull();
    expect(parseHoursToMinutes('..5')).toBeNull();
    expect(parseHoursToMinutes('1..2')).toBeNull();
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

  it('rejects unparseable input as null', () => {
    expect(parseHoursToMinutes('abc')).toBeNull();
    expect(parseHoursToMinutes('1:2:3')).toBeNull();
    expect(parseHoursToMinutes('1:75')).toBeNull(); // minutes > 59
    expect(parseHoursToMinutes('-2')).toBeNull();
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
    expect(formatMinutesAsHm(Number.NaN)).toBe('0:00');
  });
});

it('flags the 8h daily threshold', () => {
  expect(OVER_DAILY_MINUTES).toBe(480);
});
