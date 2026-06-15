import { describe, expect, it } from 'vitest';
import {
  rankOverviewMetrics,
  focusHeading,
  type OverviewMetric,
  type OverviewMetricKey,
  type OverviewMetricVariant,
} from './overviewMetrics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function metric(
  key: OverviewMetricKey,
  variant: OverviewMetricVariant,
): OverviewMetric {
  return { key, label: key, value: 'x', variant };
}

/** The six keys in intrinsic-priority order (the "all-healthy" reading order). */
const INTRINSIC_ORDER: OverviewMetricKey[] = [
  'schedule_health',
  'forecast_finish',
  'tasks_late',
  'open_risks',
  'team_utilization',
  'next_milestone',
];

function keys(metrics: OverviewMetric[]): OverviewMetricKey[] {
  return metrics.map((m) => m.key);
}

// ---------------------------------------------------------------------------
// rankOverviewMetrics
// ---------------------------------------------------------------------------

describe('rankOverviewMetrics', () => {
  it('orders by severity: critical > at-risk > neutral > on-track', () => {
    const input: OverviewMetric[] = [
      metric('next_milestone', 'on-track'),
      metric('open_risks', 'neutral'),
      metric('tasks_late', 'critical'),
      metric('team_utilization', 'at-risk'),
    ];
    const ranked = rankOverviewMetrics(input);
    expect(ranked.map((m) => m.variant)).toEqual(['critical', 'at-risk', 'neutral', 'on-track']);
  });

  it('breaks equal-severity ties by intrinsic priority', () => {
    // All on-track → must come out in intrinsic-priority order regardless of input order.
    const input: OverviewMetric[] = [
      metric('next_milestone', 'on-track'),
      metric('team_utilization', 'on-track'),
      metric('open_risks', 'on-track'),
      metric('tasks_late', 'on-track'),
      metric('forecast_finish', 'on-track'),
      metric('schedule_health', 'on-track'),
    ];
    expect(keys(rankOverviewMetrics(input))).toEqual(INTRINSIC_ORDER);
  });

  it('all-on-track yields exactly the intrinsic-priority order', () => {
    const input = INTRINSIC_ORDER.slice()
      .reverse()
      .map((k) => metric(k, 'on-track'));
    expect(keys(rankOverviewMetrics(input))).toEqual(INTRINSIC_ORDER);
  });

  it('within the same severity band, intrinsic order is preserved (stable tiebreak)', () => {
    // Two critical + two at-risk: each band internally ordered by intrinsic priority.
    const input: OverviewMetric[] = [
      metric('team_utilization', 'critical'), // intrinsic 4
      metric('schedule_health', 'critical'), // intrinsic 0
      metric('next_milestone', 'at-risk'), // intrinsic 5
      metric('tasks_late', 'at-risk'), // intrinsic 2
    ];
    expect(keys(rankOverviewMetrics(input))).toEqual([
      'schedule_health',
      'team_utilization',
      'tasks_late',
      'next_milestone',
    ]);
  });

  it('places a single critical above all neutral/on-track regardless of intrinsic priority', () => {
    // next_milestone has the lowest intrinsic priority but a critical variant must lead.
    const input: OverviewMetric[] = [
      metric('schedule_health', 'neutral'),
      metric('forecast_finish', 'on-track'),
      metric('next_milestone', 'critical'),
    ];
    expect(keys(rankOverviewMetrics(input))[0]).toBe('next_milestone');
  });

  it('slice boundary — top-3 are the worst, [3] onward the calmest', () => {
    const input: OverviewMetric[] = [
      metric('schedule_health', 'on-track'),
      metric('forecast_finish', 'neutral'),
      metric('tasks_late', 'critical'),
      metric('open_risks', 'at-risk'),
      metric('team_utilization', 'on-track'),
      metric('next_milestone', 'neutral'),
    ];
    const ranked = rankOverviewMetrics(input);
    const focus = ranked.slice(0, 3);
    const secondary = ranked.slice(3);
    // Focus = critical, at-risk, then the first neutral (by intrinsic priority).
    expect(keys(focus)).toEqual(['tasks_late', 'open_risks', 'forecast_finish']);
    // Secondary = remaining neutral + the two on-track.
    expect(keys(secondary)).toEqual(['next_milestone', 'schedule_health', 'team_utilization']);
  });

  it('does not mutate the input array', () => {
    const input: OverviewMetric[] = [
      metric('next_milestone', 'on-track'),
      metric('schedule_health', 'critical'),
    ];
    const before = keys(input);
    rankOverviewMetrics(input);
    expect(keys(input)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// focusHeading
// ---------------------------------------------------------------------------

describe('focusHeading', () => {
  it('reads "Needs attention" when any focus metric is at-risk', () => {
    expect(focusHeading([metric('schedule_health', 'at-risk')])).toBe('Needs attention');
  });

  it('reads "Needs attention" when any focus metric is critical', () => {
    expect(
      focusHeading([metric('schedule_health', 'on-track'), metric('tasks_late', 'critical')]),
    ).toBe('Needs attention');
  });

  it('reads "Project health" when the focus set is calm (on-track + neutral only)', () => {
    expect(
      focusHeading([metric('schedule_health', 'on-track'), metric('forecast_finish', 'neutral')]),
    ).toBe('Project health');
  });
});
