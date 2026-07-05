import { describe, it, expect } from 'vitest';
import { formatElapsed, formatLoggedMinutes } from './formatElapsed';

describe('formatElapsed', () => {
  it('formats sub-minute durations with padded mm:ss', () => {
    expect(formatElapsed(0)).toBe('0:00:00');
    expect(formatElapsed(6)).toBe('0:00:06');
    expect(formatElapsed(59)).toBe('0:00:59');
  });

  it('formats minutes and seconds', () => {
    expect(formatElapsed(60)).toBe('0:01:00');
    expect(formatElapsed(366)).toBe('0:06:06');
    expect(formatElapsed(3599)).toBe('0:59:59');
  });

  it('formats hours unpadded with padded minutes and seconds', () => {
    expect(formatElapsed(3600)).toBe('1:00:00');
    expect(formatElapsed(5046)).toBe('1:24:06');
    expect(formatElapsed(36000)).toBe('10:00:00');
  });

  it('floors fractional seconds', () => {
    expect(formatElapsed(5046.9)).toBe('1:24:06');
  });

  it('clamps negative or non-finite input to zero', () => {
    expect(formatElapsed(-10)).toBe('0:00:00');
    expect(formatElapsed(Number.NaN)).toBe('0:00:00');
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe('0:00:00');
  });
});

describe('formatLoggedMinutes', () => {
  it('renders bare minutes under an hour', () => {
    expect(formatLoggedMinutes(0)).toBe('0m');
    expect(formatLoggedMinutes(1)).toBe('1m');
    expect(formatLoggedMinutes(25)).toBe('25m');
    expect(formatLoggedMinutes(59)).toBe('59m');
  });

  it('renders Hh MMm at an hour or more with zero-padded minutes', () => {
    expect(formatLoggedMinutes(60)).toBe('1h 00m');
    expect(formatLoggedMinutes(65)).toBe('1h 05m');
    expect(formatLoggedMinutes(125)).toBe('2h 05m');
    expect(formatLoggedMinutes(600)).toBe('10h 00m');
  });

  it('rounds fractional minutes and clamps invalid input', () => {
    expect(formatLoggedMinutes(24.6)).toBe('25m');
    expect(formatLoggedMinutes(-5)).toBe('0m');
    expect(formatLoggedMinutes(Number.NaN)).toBe('0m');
  });
});
