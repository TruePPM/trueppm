import { describe, it, expect } from 'vitest';
import { parseDurationToMinutes } from './durationInput';

describe('parseDurationToMinutes', () => {
  it('parses h:mm clock form', () => {
    expect(parseDurationToMinutes('1:30')).toBe(90);
    expect(parseDurationToMinutes('0:15')).toBe(15);
    expect(parseDurationToMinutes('10:05')).toBe(605);
  });

  it('parses a bare integer as minutes', () => {
    expect(parseDurationToMinutes('90')).toBe(90);
    expect(parseDurationToMinutes('15')).toBe(15);
  });

  it('parses a decimal as hours', () => {
    expect(parseDurationToMinutes('1.5')).toBe(90);
    expect(parseDurationToMinutes('0.25')).toBe(15);
    expect(parseDurationToMinutes('2.0')).toBe(120);
  });

  it('trims surrounding whitespace', () => {
    expect(parseDurationToMinutes('  45  ')).toBe(45);
  });

  it('rejects empty, zero, and non-numeric input', () => {
    expect(parseDurationToMinutes('')).toBeNull();
    expect(parseDurationToMinutes('   ')).toBeNull();
    expect(parseDurationToMinutes('0')).toBeNull();
    expect(parseDurationToMinutes('0:00')).toBeNull();
    expect(parseDurationToMinutes('abc')).toBeNull();
    expect(parseDurationToMinutes('1h')).toBeNull();
  });

  it('rejects an out-of-range minutes value (> 1440)', () => {
    expect(parseDurationToMinutes('1441')).toBeNull();
    expect(parseDurationToMinutes('25:00')).toBeNull();
  });

  it('rejects a minutes field of 60+ in clock form', () => {
    // Regex caps the minutes group at 0–59, so "1:75" is not a valid clock time.
    expect(parseDurationToMinutes('1:75')).toBeNull();
  });

  it('accepts the boundary value of 1440 minutes', () => {
    expect(parseDurationToMinutes('1440')).toBe(1440);
    expect(parseDurationToMinutes('24:00')).toBe(1440);
  });
});
