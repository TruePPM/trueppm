import { describe, it, expect } from 'vitest';
import { describeBurnSeries, type NormPoint, type ScopeChange } from './burnChartData';

// ---------------------------------------------------------------------------
// Locks the screen-reader summary sentence (WCAG 1.1.1, house rule 176). The
// chart SVG is aria-hidden, so this sentence is the only accessible read of the
// series — its exact wording is a contract, not an implementation detail. These
// assertions pin the output across all variants + edge cases so the CC refactor
// (issue 2370) provably preserves it.
// ---------------------------------------------------------------------------

function pt(overrides: Partial<NormPoint> & { date: string }): NormPoint {
  return {
    remaining: null,
    completed: null,
    scope: null,
    ideal: 0,
    ...overrides,
  };
}

describe('describeBurnSeries', () => {
  const burndownPoints: NormPoint[] = [
    pt({ date: '2026-04-01', remaining: 40, ideal: 40 }),
    pt({ date: '2026-04-05', remaining: 22, ideal: 25 }),
  ];

  it('summarizes a burndown with remaining vs ideal and trend', () => {
    expect(describeBurnSeries(burndownPoints, 'burndown', 'points', [], 3.4)).toBe(
      'Burndown chart as of 2026-04-05: 22 story points remaining versus an ideal of 25; ' +
        '3 story points ahead of the ideal pace.',
    );
  });

  it('uses "tasks" as the unit under the tasks metric and "behind" for a negative trend', () => {
    expect(describeBurnSeries(burndownPoints, 'burndown', 'tasks', [], -2.6)).toBe(
      'Burndown chart as of 2026-04-05: 22 tasks remaining versus an ideal of 25; ' +
        '3 tasks behind the ideal pace.',
    );
  });

  it('summarizes a burn-up with completed of scope', () => {
    const points: NormPoint[] = [
      pt({ date: '2026-04-01', completed: 0, scope: 40 }),
      pt({ date: '2026-04-05', completed: 15, scope: 48 }),
    ];
    expect(describeBurnSeries(points, 'burnup', 'points', [], null)).toBe(
      'Burn-up chart as of 2026-04-05: 15 of 48 story points completed.',
    );
  });

  it('combines remaining and completed clauses for the combined variant', () => {
    const points: NormPoint[] = [
      pt({ date: '2026-04-05', remaining: 22, completed: 18, scope: 40, ideal: 25 }),
    ];
    expect(describeBurnSeries(points, 'combined', 'points', [], null)).toBe(
      'Combined burn chart as of 2026-04-05: 22 story points remaining versus an ideal of 25; ' +
        '18 of 40 story points completed.',
    );
  });

  it('appends scope additions and removals, pluralized', () => {
    const changes: ScopeChange[] = [
      { date: '2026-04-03', delta: 5, newScope: 45 },
      { date: '2026-04-04', delta: 3, newScope: 48 },
      { date: '2026-04-06', delta: -2, newScope: 46 },
    ];
    expect(describeBurnSeries(burndownPoints, 'burndown', 'points', changes, null)).toBe(
      'Burndown chart as of 2026-04-05: 22 story points remaining versus an ideal of 25; ' +
        '2 scope additions and 1 scope removal.',
    );
  });

  it('reports "no data yet" when every clause is empty', () => {
    expect(describeBurnSeries([], 'burndown', 'points', [], null)).toBe(
      'Burndown chart: no data yet.',
    );
  });

  it('omits the "as of" fragment when there are no points', () => {
    const changes: ScopeChange[] = [{ date: '2026-04-03', delta: 4, newScope: 44 }];
    expect(describeBurnSeries([], 'burnup', 'points', changes, null)).toBe(
      'Burn-up chart: 1 scope addition.',
    );
  });
});
