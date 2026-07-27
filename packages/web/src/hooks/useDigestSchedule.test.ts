import { describe, expect, it } from 'vitest';
import { describeSchedule, formatHour, WEEKDAY_LABELS } from './useDigestSchedule';

describe('formatHour', () => {
  it('renders midnight and noon as 12, not 0', () => {
    expect(formatHour(0)).toBe('12:00 am');
    expect(formatHour(12)).toBe('12:00 pm');
  });

  it('renders morning and evening hours', () => {
    expect(formatHour(9)).toBe('9:00 am');
    expect(formatHour(17)).toBe('5:00 pm');
    expect(formatHour(23)).toBe('11:00 pm');
  });
});

describe('WEEKDAY_LABELS', () => {
  it('is Monday-first, matching the server 0=Monday convention', () => {
    // Guards against a refactor that reaches for JS Date#getDay (0=Sunday) and
    // silently shifts every user's digest by a day.
    expect(WEEKDAY_LABELS[0]).toBe('Monday');
    expect(WEEKDAY_LABELS[6]).toBe('Sunday');
    expect(WEEKDAY_LABELS).toHaveLength(7);
  });
});

describe('describeSchedule', () => {
  it('names the day, the time, and the timezone', () => {
    expect(
      describeSchedule({ digest_weekday: 6, digest_hour: 17, digest_timezone: 'America/New_York' }),
    ).toBe('Digests send Sundays at 5:00 pm (America/New_York).');
  });

  it('falls back to a readable phrase when no timezone is set', () => {
    expect(describeSchedule({ digest_weekday: 0, digest_hour: 9, digest_timezone: '' })).toBe(
      'Digests send Mondays at 9:00 am (your server timezone).',
    );
  });

  it('does not crash on an out-of-range weekday from the server', () => {
    expect(
      describeSchedule({ digest_weekday: 99, digest_hour: 9, digest_timezone: '' }),
    ).toContain('Sundays');
  });
});
