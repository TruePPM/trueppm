/**
 * The copy rules — above all ADR-0784 §D5: we state the fact and NEVER invent a
 * cause the client cannot prove.
 */
import { describe, it, expect } from 'vitest';

import {
  MON_FRI_MASK,
  announcement,
  cellAriaLabel,
  changedCountLabel,
  deriveCause,
  describeDivergence,
  fmtCellDate,
  isWorkingDay,
} from './reconcileCopy';
import type { ReconcileEntry } from './reconcileState';

function entry(over: Partial<ReconcileEntry> = {}): ReconcileEntry {
  return {
    taskId: 't1',
    field: 'finish',
    taskName: 'Spec freeze',
    status: 'diverged',
    expected: '2026-10-13',
    actual: '2026-10-16',
    reason: null,
    retry: null,
    since: 0,
    ...over,
  };
}

describe('isWorkingDay', () => {
  it('reads the weekday in UTC, not viewer-local', () => {
    // 2026-10-16 is a Friday in UTC. A local read from a timezone behind UTC
    // would see Thursday — the rule-56 bug class that CI cannot catch because
    // the runner sits on UTC.
    expect(isWorkingDay('2026-10-16', MON_FRI_MASK)).toBe(true);
    expect(isWorkingDay('2026-10-17', MON_FRI_MASK)).toBe(false); // Saturday
    expect(isWorkingDay('2026-10-18', MON_FRI_MASK)).toBe(false); // Sunday
  });

  it('honors a non-Mon–Fri mask', () => {
    const satSun = 32 | 64;
    expect(isWorkingDay('2026-10-17', satSun)).toBe(true);
    expect(isWorkingDay('2026-10-16', satSun)).toBe(false);
  });
});

describe('deriveCause — the honesty rule (§D5)', () => {
  it('names a non-working day, because the weekly mask PROVES it', () => {
    // 2026-10-17 is a Saturday.
    expect(deriveCause(entry({ expected: '2026-10-17' }), MON_FRI_MASK)).toBe(
      'Oct 17 is not a working day',
    );
  });

  it('returns NULL when the old date was a working day — we do not guess', () => {
    // The move came from a holiday row, a cascade, or a constraint: things the
    // client cannot see. Inventing "the July shutdown week" here is the failure
    // this test exists to prevent.
    expect(deriveCause(entry({ expected: '2026-10-13' }), MON_FRI_MASK)).toBeNull();
  });

  it('returns null when there is no server value yet', () => {
    expect(deriveCause(entry({ actual: null }), MON_FRI_MASK)).toBeNull();
  });
});

describe('describeDivergence', () => {
  it('states the bare fact when no cause is provable', () => {
    expect(describeDivergence(entry(), MON_FRI_MASK)).toBe('Finish moved Oct 13 → Oct 16');
  });

  it('appends only the mask-provable qualifier', () => {
    expect(describeDivergence(entry({ expected: '2026-10-17' }), MON_FRI_MASK)).toBe(
      'Finish moved Oct 17 → Oct 16: Oct 17 is not a working day',
    );
  });

  it('uses the right noun for the start field', () => {
    expect(describeDivergence(entry({ field: 'start' }), MON_FRI_MASK)).toMatch(/^Start moved/);
  });
});

describe('cellAriaLabel — the only sightless carrier of the marker', () => {
  it('marks a preview as pending, since italic is purely visual', () => {
    expect(cellAriaLabel('start', '2026-10-13', entry({ field: 'start', status: 'preview' }))).toBe(
      'starts Oct 13, pending confirmation',
    );
  });

  it('spells out the full old → new claim the 74px cell cannot show', () => {
    expect(cellAriaLabel('finish', '2026-10-16', entry())).toBe(
      'finish moved from Oct 13 to Oct 16, not yet reviewed',
    );
  });

  it('carries the server reason on a refusal', () => {
    expect(
      cellAriaLabel('finish', '2026-10-13', entry({ status: 'rejected', reason: 'Task is locked.' })),
    ).toBe('finishes Oct 13, change refused: Task is locked.');
  });

  it('falls back to the plain label with no entry, and to unscheduled with no value', () => {
    expect(cellAriaLabel('start', '2026-10-13', undefined)).toBe('starts Oct 13');
    expect(cellAriaLabel('start', null, undefined)).toBe('unscheduled');
  });
});

describe('announcement', () => {
  it('is empty when there is nothing to say, so no stale count is re-read', () => {
    expect(announcement(0, '2026-10-16')).toBe('');
  });

  it('reads the sentence from the issue', () => {
    expect(announcement(3, '2026-10-16')).toBe(
      'Schedule recomputed. 3 dates changed. Project finish now October 16, 2026.',
    );
  });

  it('singularizes, and omits the finish clause when unknown', () => {
    expect(announcement(1, null)).toBe('Schedule recomputed. 1 date changed.');
  });
});

describe('fmtCellDate', () => {
  it('collapses an unparseable date to an em dash rather than leaking the raw string', () => {
    expect(fmtCellDate('not-a-date')).toBe('—');
    expect(fmtCellDate('')).toBe('—');
    expect(fmtCellDate(null)).toBe('—');
  });
});

describe('changedCountLabel', () => {
  it('singularizes', () => {
    expect(changedCountLabel(1)).toBe('1 date changed');
    expect(changedCountLabel(4)).toBe('4 dates changed');
  });
});
