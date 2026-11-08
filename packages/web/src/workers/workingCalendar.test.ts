import { describe, expect, it } from 'vitest';
import {
  buildWorkingDayPredicate,
  countWorkingDaysInclusive,
  finishFromStartIso,
  firstWorkingDayOnOrAfter,
  lastWorkingDayOnOrBefore,
  mergeExceptionRanges,
  resolveWorkingDayPredicate,
  monFriWorkingDay,
  type PreviewCalendar,
} from './workingCalendar';

const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const day = (iso: string) => Math.floor(ms(iso) / 86_400_000);

describe('mergeExceptionRanges', () => {
  it('sorts and merges overlapping and day-adjacent ranges, keeping gaps apart', () => {
    const { starts, ends } = mergeExceptionRanges([
      { start: '2026-03-12', end: '2026-03-13' },
      { start: '2026-03-05', end: '2026-03-06' },
      { start: '2026-03-11', end: '2026-03-12' }, // overlaps the first
      { start: '2026-03-14', end: '2026-03-14' }, // adjacent to it
      { start: '2026-03-16', end: '2026-03-16' }, // one-day gap: separate
    ]);
    expect(starts).toEqual([day('2026-03-05'), day('2026-03-11'), day('2026-03-16')]);
    expect(ends).toEqual([day('2026-03-06'), day('2026-03-14'), day('2026-03-16')]);
  });

  it('keeps a range wholly inside another as one interval', () => {
    const { starts, ends } = mergeExceptionRanges([
      { start: '2026-01-01', end: '2026-01-31' },
      { start: '2026-01-10', end: '2026-01-12' },
    ]);
    expect(starts).toEqual([day('2026-01-01')]);
    expect(ends).toEqual([day('2026-01-31')]);
  });

  it('drops an inverted or unparseable range rather than inventing a holiday', () => {
    const { starts } = mergeExceptionRanges([
      { start: '2026-01-10', end: '2026-01-09' },
      { start: 'nope', end: '2026-01-09' },
    ]);
    expect(starts).toEqual([]);
  });
});

describe('buildWorkingDayPredicate', () => {
  it('falls back to Mon–Fri with no calendar', () => {
    expect(buildWorkingDayPredicate(null)).toBe(monFriWorkingDay);
    expect(buildWorkingDayPredicate(undefined)).toBe(monFriWorkingDay);
    expect(monFriWorkingDay(ms('2026-03-06'))).toBe(true); // Fri
    expect(monFriWorkingDay(ms('2026-03-07'))).toBe(false); // Sat
    expect(monFriWorkingDay(ms('2026-03-08'))).toBe(false); // Sun
    expect(monFriWorkingDay(ms('2026-03-09'))).toBe(true); // Mon
  });

  it('reads the mask with bit 0 = Monday, as the Python engine does', () => {
    // Mon–Thu + Sun (bits 0-3 and 6).
    const isWorking = buildWorkingDayPredicate({ working_days: 0b1001111, exceptions: [] });
    const week = [
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
    ];
    expect(week.map((d) => isWorking(ms(d)))).toEqual([true, true, true, true, false, false, true]);
  });

  it('excludes every day of a merged exception interval and nothing either side', () => {
    const isWorking = buildWorkingDayPredicate({
      working_days: 0b1111111,
      exceptions: [
        { start: '2026-03-11', end: '2026-03-12' },
        { start: '2026-03-12', end: '2026-03-13' },
      ],
    });
    expect(isWorking(ms('2026-03-10'))).toBe(true);
    expect(isWorking(ms('2026-03-11'))).toBe(false);
    expect(isWorking(ms('2026-03-12'))).toBe(false);
    expect(isWorking(ms('2026-03-13'))).toBe(false);
    expect(isWorking(ms('2026-03-14'))).toBe(true);
  });

  it('answers a day before every interval and after the last one', () => {
    const isWorking = buildWorkingDayPredicate({
      working_days: 0b1111111,
      exceptions: [{ start: '2026-06-01', end: '2026-06-05' }],
    });
    expect(isWorking(ms('2026-05-31'))).toBe(true);
    expect(isWorking(ms('2026-06-06'))).toBe(true);
  });

  it('treats an empty mask as Mon–Fri instead of letting the stepping loops spin', () => {
    expect(buildWorkingDayPredicate({ working_days: 0, exceptions: [] })).toBe(monFriWorkingDay);
  });

  it('memoizes per calendar object', () => {
    const cal: PreviewCalendar = { working_days: 0b0011111, exceptions: [] };
    expect(buildWorkingDayPredicate(cal)).toBe(buildWorkingDayPredicate(cal));
  });
});

describe('resolveWorkingDayPredicate / countWorkingDaysInclusive / lastWorkingDayOnOrBefore', () => {
  const holiday = {
    working_days: 0b0011111,
    exceptions: [{ start: '2026-03-05', end: '2026-03-05' }],
  };

  it('prefers the composed calendar, then the mask, then Mon–Fri', () => {
    const composed = resolveWorkingDayPredicate(holiday, 0b1111111);
    expect(composed(ms('2026-03-05'))).toBe(false);
    const maskOnly = resolveWorkingDayPredicate(null, 0b1111111);
    expect(maskOnly(ms('2026-03-07'))).toBe(true); // Sat
    expect(resolveWorkingDayPredicate(null, null)).toBe(monFriWorkingDay);
  });

  it('counts inclusively, excluding holidays, never below 1', () => {
    const p = resolveWorkingDayPredicate(holiday);
    expect(countWorkingDaysInclusive('2026-03-02', '2026-03-06', p)).toBe(4);
    expect(countWorkingDaysInclusive('2026-03-07', '2026-03-08', p)).toBe(1);
  });

  it('snaps a non-working day back to the working day before, never past the floor', () => {
    const p = resolveWorkingDayPredicate(holiday);
    expect(lastWorkingDayOnOrBefore('2026-03-05', '2026-03-02', p)).toBe('2026-03-04');
    expect(lastWorkingDayOnOrBefore('2026-03-08', '2026-03-02', p)).toBe('2026-03-06');
    expect(lastWorkingDayOnOrBefore('2026-03-06', '2026-03-02', p)).toBe('2026-03-06');
    expect(lastWorkingDayOnOrBefore('2026-03-08', '2026-03-08', p)).toBe('2026-03-08');
  });
});

describe('firstWorkingDayOnOrAfter / finishFromStartIso (#4170)', () => {
  const p = buildWorkingDayPredicate({
    working_days: 0b0011111,
    exceptions: [{ start: '2026-03-05', end: '2026-03-05' }],
  });

  it('snaps a non-working start forward and leaves a working one alone', () => {
    expect(firstWorkingDayOnOrAfter('2026-03-05', p)).toBe('2026-03-06');
    expect(firstWorkingDayOnOrAfter('2026-03-07', p)).toBe('2026-03-09');
    expect(firstWorkingDayOnOrAfter('2026-03-04', p)).toBe('2026-03-04');
  });

  it('walks the duration over working days from the snapped start', () => {
    expect(finishFromStartIso('2026-03-02', 5, p)).toBe('2026-03-09'); // 2,3,4,6,9
    expect(finishFromStartIso('2026-03-05', 1, p)).toBe('2026-03-06');
    expect(finishFromStartIso('2026-03-07', 0, p)).toBe('2026-03-07'); // a milestone
  });
});
