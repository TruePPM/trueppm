import { describe, expect, it } from 'vitest';
import {
  formatCadence,
  formatDuration,
  formatTime,
  parseMonthlyDay,
} from './cadenceCopy';

describe('formatCadence', () => {
  it('renders weekly with weekday and time', () => {
    expect(
      formatCadence({
        cadence_type: 'weekly',
        cadence_day: 'monday',
        cadence_time: '10:00:00',
      }),
    ).toBe('Weekly · Monday 10:00');
  });

  it('renders biweekly with weekday and time', () => {
    expect(
      formatCadence({
        cadence_type: 'biweekly',
        cadence_day: 'wednesday',
        cadence_time: '11:00:00',
      }),
    ).toBe('Bi-weekly · Wednesday 11:00');
  });

  it('renders monthly with ordinal and weekday', () => {
    expect(
      formatCadence({
        cadence_type: 'monthly',
        cadence_day: '1st-thursday',
        cadence_time: '14:00:00',
      }),
    ).toBe('Monthly · first Thursday 14:00');
  });

  it('renders on_milestone with no day or time', () => {
    expect(
      formatCadence({
        cadence_type: 'on_milestone',
        cadence_day: '',
        cadence_time: null,
      }),
    ).toBe('On milestone');
  });
});

describe('formatTime', () => {
  it('truncates seconds and microseconds', () => {
    expect(formatTime('10:00:00')).toBe('10:00');
    expect(formatTime('10:00:00.123456')).toBe('10:00');
  });
  it('returns empty string for null/empty input', () => {
    expect(formatTime(null)).toBe('');
    expect(formatTime('')).toBe('');
  });
});

describe('parseMonthlyDay', () => {
  it('splits ordinal and weekday', () => {
    expect(parseMonthlyDay('1st-thursday')).toEqual({
      ordinal: '1st',
      weekday: 'thursday',
    });
    expect(parseMonthlyDay('last-friday')).toEqual({
      ordinal: 'last',
      weekday: 'friday',
    });
  });
  it('returns null for malformed input', () => {
    expect(parseMonthlyDay('')).toBeNull();
    expect(parseMonthlyDay('monday')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('appends "min"', () => {
    expect(formatDuration(60)).toBe('60 min');
  });
});
