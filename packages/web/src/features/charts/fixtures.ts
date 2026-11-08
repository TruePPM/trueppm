import type { MonteCarloResult } from '@/types';
import type { SCurveSeries } from './SCurveChart';
import type { BurnPoint } from './StepBurnChart';

/**
 * Sample data for the chart specimen page, the unit tests and the screenshot
 * specs. `FORECAST` has the shape the metric-provenance forecast endpoint serves
 * (ADR-1314); its P50/P80/commitment dates are deliberately within days of each
 * other so the label-collision path is exercised at the design's sample data.
 */
export const FORECAST: Pick<
  MonteCarloResult,
  'p50' | 'p80' | 'p95' | 'confidenceCurve' | 'commitmentDate' | 'definitions'
> = {
  p50: '2026-06-05',
  p80: '2026-06-08',
  p95: '2026-06-12',
  commitmentDate: '2026-06-06',
  definitions: {
    p80: 'P80: the date by which 80 of every 100 simulated runs of this schedule finish.',
  },
  confidenceCurve: [
    ['2026-05-22', 2],
    ['2026-05-27', 12],
    ['2026-06-01', 31],
    ['2026-06-03', 42],
    ['2026-06-05', 50],
    ['2026-06-08', 80],
    ['2026-06-10', 91],
    ['2026-06-12', 95],
    ['2026-06-17', 100],
  ].map(([date, pct]) => ({ date: date as string, pct: pct as number })),
};

export const PROGRESS_SERIES: SCurveSeries[] = [
  {
    key: 'planned',
    label: 'Planned',
    dash: 'dashed',
    tone: 'neutral',
    points: [
      ['2026-04-01', 0],
      ['2026-04-15', 8],
      ['2026-05-01', 22],
      ['2026-05-15', 45],
      ['2026-06-01', 78],
      ['2026-06-15', 100],
    ].map(([date, value]) => ({ date: date as string, value: value as number })),
  },
  {
    key: 'actual',
    label: 'Actual',
    dash: 'solid',
    tone: 'brand',
    points: [
      ['2026-04-01', 0],
      ['2026-04-15', 6],
      ['2026-05-01', 17],
      ['2026-05-15', 36],
      ['2026-05-25', 52],
    ].map(([date, value]) => ({ date: date as string, value: value as number })),
  },
];

export const BURNDOWN: BurnPoint[] = [
  ['2026-05-04', 42],
  ['2026-05-05', 42],
  ['2026-05-06', 38],
  ['2026-05-07', 38],
  ['2026-05-08', 31],
  ['2026-05-11', 31],
  ['2026-05-12', 24],
  ['2026-05-13', 20],
  ['2026-05-14', 20],
  ['2026-05-15', 11],
].map(([date, value]) => ({ date: date as string, value: value as number }));

export const BURNDOWN_IDEAL: BurnPoint[] = [
  { date: '2026-05-04', value: 42 },
  { date: '2026-05-15', value: 0 },
];
