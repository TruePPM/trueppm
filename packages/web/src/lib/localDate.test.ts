// Pin a non-UTC timezone BEFORE importing the module under test so its Date
// reads resolve against a zone west of UTC — the scenario where the UTC day and
// the local day disagree near midnight (#1928). CI runs in UTC, so without this
// the divergence assertion below would be untestable.
// eslint-disable-next-line no-undef -- `process` is available in the vitest (node) runtime; test files only load browser globals in eslint.
process.env.TZ = 'America/Los_Angeles';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { localDateIso, localTodayIso } from './localDate';

describe('localTodayIso', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the local calendar day, not the UTC day, near midnight', () => {
    // 2026-01-15T05:00:00Z is 2026-01-14 21:00 in America/Los_Angeles (UTC-8).
    // toISOString().slice(0,10) would wrongly report 2026-01-15.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T05:00:00Z'));

    expect(localTodayIso()).toBe('2026-01-14');
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-01-15');
  });

  it('agrees with UTC when the instant is mid-local-day', () => {
    // 2026-06-15T20:00:00Z is 2026-06-15 13:00 in Los Angeles (PDT, UTC-7).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T20:00:00Z'));

    expect(localTodayIso()).toBe('2026-06-15');
  });
});

describe('localDateIso', () => {
  it('formats a Date as zero-padded YYYY-MM-DD in local components', () => {
    // Local wall-clock 2026-03-07 (any time of day) formats identically.
    const d = new Date(2026, 2, 7, 8, 30);
    expect(localDateIso(d)).toBe('2026-03-07');
  });
});
