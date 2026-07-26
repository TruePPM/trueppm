import { describe, it, expect } from 'vitest';
import {
  formatShortDate,
  nudgeWorkingDays,
  computeInitialScrollLeft,
  computeInitialFraming,
  framedBarCoverage,
  type RowBar,
} from './scheduleUtils';

// ---------------------------------------------------------------------------
// formatShortDate
// ---------------------------------------------------------------------------

// formatShortDate wraps a UTC-pinned Intl.DateTimeFormat; the reference formatter
// must also pin timeZone:'UTC' so the contract test holds in any runner zone.
const fmt = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(iso),
  );

describe('formatShortDate', () => {
  it('matches UTC-pinned Intl.DateTimeFormat en-US short month + numeric day', () => {
    expect(formatShortDate('2025-04-07')).toBe(fmt('2025-04-07'));
  });

  it('contains the month abbreviation for the given month', () => {
    expect(formatShortDate('2025-12-25')).toContain('Dec');
  });

  it('does not include a four-digit year', () => {
    expect(formatShortDate('2025-01-05')).not.toMatch(/\d{4}/);
  });

  // Regression guard for #1927: a date-only ISO parses to UTC midnight. Without
  // timeZone:'UTC' the formatter renders in the browser's local zone and shows
  // the *previous* calendar day for every viewer west of UTC. Pinning the
  // expected output to the UTC calendar day fails if the UTC pinning regresses
  // (on any machine whose local zone is west of UTC — CI and most dev machines).
  it('renders the UTC calendar day, not the local day west of UTC', () => {
    expect(formatShortDate('2025-04-07')).toBe('Apr 7');
    expect(formatShortDate('2026-01-01')).toBe('Jan 1');
  });
});

describe('nudgeWorkingDays', () => {
  // 2025-03-17 is a Monday
  const MONDAY = '2025-03-17';
  // 2025-03-21 is a Friday
  const FRIDAY = '2025-03-21';
  // 2025-03-22 is a Saturday
  const SATURDAY = '2025-03-22';

  it('returns the same date for 0 days', () => {
    expect(nudgeWorkingDays(MONDAY, 0)).toBe(MONDAY);
  });

  it('advances by 1 working day (Mon → Tue)', () => {
    expect(nudgeWorkingDays(MONDAY, 1)).toBe('2025-03-18');
  });

  it('advances by 5 working days (Mon → next Mon)', () => {
    expect(nudgeWorkingDays(MONDAY, 5)).toBe('2025-03-24');
  });

  it('retreats by 1 working day (Mon → Fri)', () => {
    expect(nudgeWorkingDays(MONDAY, -1)).toBe('2025-03-14');
  });

  it('retreats by 5 working days (Mon → Mon)', () => {
    expect(nudgeWorkingDays(MONDAY, -5)).toBe('2025-03-10');
  });

  it('skips Saturday when advancing from Friday', () => {
    // Fri + 1 working day = Monday
    expect(nudgeWorkingDays(FRIDAY, 1)).toBe('2025-03-24');
  });

  it('skips Saturday and Sunday when retreating from Monday', () => {
    // Mon - 1 working day = Friday
    expect(nudgeWorkingDays(MONDAY, -1)).toBe('2025-03-14');
  });

  it('accepts a date that starts on Saturday (advances to next Monday)', () => {
    // Saturday + 1 working day = Monday
    expect(nudgeWorkingDays(SATURDAY, 1)).toBe('2025-03-24');
  });

  it('handles large nudge (10 working days = 2 calendar weeks)', () => {
    // Mon + 10 working days = Monday 2 weeks later
    expect(nudgeWorkingDays(MONDAY, 10)).toBe('2025-03-31');
  });

  it('returns a YYYY-MM-DD string regardless of input length', () => {
    const result = nudgeWorkingDays('2025-03-17', 3);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// computeInitialScrollLeft (rule 81 framing, #2004)
// ---------------------------------------------------------------------------

describe('computeInitialScrollLeft', () => {
  it('places today at 25% from the left when there is room on both sides', () => {
    // todayX 1507, viewport 1100 → 1507 - 275 = 1232, within [0, 2812].
    expect(computeInitialScrollLeft(1507, 1100, 2812)).toBe(1232);
  });

  it('returns null when the whole chart fits (maxScroll <= 0)', () => {
    // The #2004 regression: framing must NOT resolve to 0 here — a 0 would look
    // "framed" while actually being the unscrollable project start.
    expect(computeInitialScrollLeft(1507, 1100, 0)).toBeNull();
    expect(computeInitialScrollLeft(1507, 1100, -50)).toBeNull();
  });

  it('clamps to 0 when today is near the project start (target would be negative)', () => {
    // todayX 100 → 100 - 275 = -175 → clamped up to 0.
    expect(computeInitialScrollLeft(100, 1100, 2812)).toBe(0);
  });

  it('clamps to maxScroll when today is past the last bar but still on the chart', () => {
    // todayX within the content (scrollWidth = maxScroll + viewport = 3912): today
    // sits in the trailing buffer, so framing still shows the project on the left.
    expect(computeInitialScrollLeft(3800, 1100, 2812)).toBe(2812);
  });

  it('returns null when today is entirely past the chart (finished project)', () => {
    // todayX 9000 > scrollWidth 3912 → today is off the whole chart. Framing here
    // would scroll into the empty trailing buffer and hide the project, so skip it
    // and leave the default project-start view (#2004).
    expect(computeInitialScrollLeft(9000, 1100, 2812)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// framedBarCoverage / computeInitialFraming (#2423)
// ---------------------------------------------------------------------------

/** Fourteen rows whose bars all sit well left of the viewport — the demo project. */
function barsBehind(): (RowBar | null)[] {
  return Array.from({ length: 14 }, (_, i) => ({ x0: 100 + i * 40, x1: 300 + i * 40 }));
}

describe('framedBarCoverage', () => {
  it('counts a bar that merely overlaps the viewport edge as framed', () => {
    // A bar straddling the left edge is visible, so it counts — using strict
    // containment here would fail a project whose bars are wider than the screen.
    const bars: RowBar[] = [
      { x0: 900, x1: 1100 },
      { x0: 1900, x1: 2100 },
    ];
    expect(framedBarCoverage(bars, 1000, 2000)).toBe(1);
  });

  it('excludes rows with no bar from both numerator and denominator', () => {
    // An unscheduled task has no bar at any offset, so no framing decision can
    // rescue it — counting it would drag the ratio down for a reason framing
    // cannot fix.
    const bars: (RowBar | null)[] = [{ x0: 1100, x1: 1200 }, null, null, { x0: 9000, x1: 9100 }];
    expect(framedBarCoverage(bars, 1000, 2000)).toBe(0.5);
  });

  it('returns null when no row carries a bar', () => {
    expect(framedBarCoverage([null, null], 0, 1000)).toBeNull();
  });
});

describe('computeInitialFraming', () => {
  it('falls back to fitToProject when today framing would show mostly empty canvas', () => {
    // The reported defect: the demo project starts in April, today is in July, so
    // the rule-81 offset lands past every bar and nine of fourteen rows open blank.
    expect(computeInitialFraming(3000, 1100, 4000, barsBehind())).toEqual({ kind: 'fit' });
  });

  it('keeps rule 81 when the project straddles today', () => {
    // todayX 1507, viewport 1100 → scrollLeft 1232, framing [1232, 2332].
    const bars: RowBar[] = [
      { x0: 1300, x1: 1600 },
      { x0: 1500, x1: 1900 },
      { x0: 1800, x1: 2200 },
      { x0: 4000, x1: 4200 },
    ];
    expect(computeInitialFraming(1507, 1100, 2812, bars)).toEqual({
      kind: 'scroll',
      scrollLeft: 1232,
    });
  });

  it('does not regress rule 81 for a project entirely in the future', () => {
    // Today sits left of the chart, so the target clamps to 0 and the project
    // start — the meaningful view — is what shows. This is the case rule 81 was
    // written for, and the coverage gate must not steal it.
    const bars: RowBar[] = [
      { x0: 0, x1: 400 },
      { x0: 300, x1: 800 },
    ];
    expect(computeInitialFraming(-200, 1100, 2000, bars)).toEqual({ kind: 'scroll', scrollLeft: 0 });
  });

  it('reports none when there is nothing to frame, without consulting coverage', () => {
    // maxScroll <= 0: the whole chart already fits, so both scrolling and fitting
    // are no-ops and the default view is already correct (#2004).
    expect(computeInitialFraming(1507, 1100, 0, barsBehind())).toEqual({ kind: 'none' });
  });

  it('frames on today when every visible row is unscheduled', () => {
    // No bar anywhere means fitToProject has nothing better to offer, so the
    // near-term context of rule 81 remains the most useful default.
    expect(computeInitialFraming(1507, 1100, 2812, [null, null, null])).toEqual({
      kind: 'scroll',
      scrollLeft: 1232,
    });
  });
});
