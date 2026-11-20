import { describe, expect, it } from 'vitest';
import { deadlineSlipDays } from './deadlineVariance';

const base = { start: '2026-03-02', finish: '2026-03-13', isMilestone: false };

describe('deadlineSlipDays', () => {
  it('is null without a deadline', () => {
    expect(deadlineSlipDays({ ...base, deadline: null })).toBeNull();
    expect(deadlineSlipDays({ ...base, deadline: undefined })).toBeNull();
  });

  it('is null when the finish is on or before the deadline', () => {
    expect(deadlineSlipDays({ ...base, deadline: '2026-03-13' })).toBeNull();
    expect(deadlineSlipDays({ ...base, deadline: '2026-03-20' })).toBeNull();
  });

  it('counts calendar days past the deadline', () => {
    expect(deadlineSlipDays({ ...base, deadline: '2026-03-10' })).toBe(3);
  });

  it('compares a milestone by its single date', () => {
    expect(
      deadlineSlipDays({
        start: '2026-03-12',
        finish: '2026-03-12',
        isMilestone: true,
        deadline: '2026-03-11',
      }),
    ).toBe(1);
  });

  it('is null when the schedule has not been computed', () => {
    expect(
      deadlineSlipDays({ start: '', finish: '', isMilestone: false, deadline: '2026-03-10' }),
    ).toBeNull();
  });
});
