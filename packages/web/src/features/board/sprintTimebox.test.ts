import { describe, it, expect } from 'vitest';
import { sprintTimebox } from './sprintTimebox';

describe('sprintTimebox', () => {
  const start = '2026-03-04';
  const finish = '2026-03-17'; // inclusive -> 14 days

  it('computes inclusive total days', () => {
    const tb = sprintTimebox(start, finish, new Date('2026-03-10T12:00:00'));
    expect(tb.totalDays).toBe(14);
  });

  it('phase=during with the correct 1-based dayN mid-window', () => {
    // Mar 10 is the 7th inclusive day (Mar 4 = day 1).
    const tb = sprintTimebox(start, finish, new Date('2026-03-10T09:00:00'));
    expect(tb.phase).toBe('during');
    expect(tb.dayN).toBe(7);
  });

  it('day 1 on the start date', () => {
    const tb = sprintTimebox(start, finish, new Date('2026-03-04T23:00:00'));
    expect(tb.phase).toBe('during');
    expect(tb.dayN).toBe(1);
  });

  it('last day on the finish date', () => {
    const tb = sprintTimebox(start, finish, new Date('2026-03-17T00:30:00'));
    expect(tb.phase).toBe('during');
    expect(tb.dayN).toBe(14);
  });

  it('phase=before clamps dayN to 1', () => {
    const tb = sprintTimebox(start, finish, new Date('2026-03-01T08:00:00'));
    expect(tb.phase).toBe('before');
    expect(tb.dayN).toBe(1);
  });

  it('phase=after clamps dayN to totalDays', () => {
    const tb = sprintTimebox(start, finish, new Date('2026-03-25T08:00:00'));
    expect(tb.phase).toBe('after');
    expect(tb.dayN).toBe(14);
  });

  it('single-day sprint (start === finish) has totalDays 1', () => {
    const tb = sprintTimebox('2026-03-04', '2026-03-04', new Date('2026-03-04T12:00:00'));
    expect(tb.totalDays).toBe(1);
    expect(tb.dayN).toBe(1);
    expect(tb.phase).toBe('during');
  });

  it('single-day sprint, day before is phase=before', () => {
    const tb = sprintTimebox('2026-03-04', '2026-03-04', new Date('2026-03-03T12:00:00'));
    expect(tb.phase).toBe('before');
    expect(tb.dayN).toBe(1);
  });
});
