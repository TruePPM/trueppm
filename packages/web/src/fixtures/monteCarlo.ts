import type { MonteCarloResult } from '@/types';

/**
 * Fixture Monte Carlo result for the "Falcon Platform Rebrand" project.
 * Distribution is pre-bucketed by week (1 000 simulated runs).
 * P50 = 2026-10-05, P80 = 2026-11-03, P95 = 2026-11-30.
 *
 * Bucket counts approximate a right-skewed PERT-Beta distribution.
 * Replace with real useQuery result once the API is wired.
 */
export const FIXTURE_MC_RESULT: MonteCarloResult = {
  projectId: 'proj-1',
  runs: 1000,
  p50: '2026-10-05',
  p80: '2026-11-03',
  p95: '2026-11-30',
  buckets: [
    { weekStart: '2026-08-31', count: 2 },
    { weekStart: '2026-09-07', count: 8 },
    { weekStart: '2026-09-14', count: 22 },
    { weekStart: '2026-09-21', count: 48 },
    { weekStart: '2026-09-28', count: 95 },
    { weekStart: '2026-10-05', count: 148 }, // ← P50 sits here
    { weekStart: '2026-10-12', count: 162 },
    { weekStart: '2026-10-19', count: 138 },
    { weekStart: '2026-10-26', count: 112 },
    { weekStart: '2026-11-02', count: 88 },  // ← P80 sits here
    { weekStart: '2026-11-09', count: 62 },
    { weekStart: '2026-11-16', count: 42 },
    { weekStart: '2026-11-23', count: 28 },  // ← P95 sits here
    { weekStart: '2026-11-30', count: 18 },
    { weekStart: '2026-12-07', count: 12 },
    { weekStart: '2026-12-14', count: 8 },
    { weekStart: '2026-12-21', count: 5 },
    { weekStart: '2026-12-28', count: 2 },
  ],
  // Server-computed CPM finish + risk deltas + cumulative S-curve (#987). The
  // UI renders these directly. cpmFinish 2026-10-05 → P50 +0d, P80 +29d,
  // P95 +56d. The confidence curve mirrors the cumulative share of the buckets
  // above (1000 runs), the same value the panel previously accumulated client-side.
  cpmFinish: '2026-10-05',
  deltaVsCpm: { p50: 0, p80: 29, p95: 56 },
  confidenceCurve: [
    { date: '2026-08-31', pct: 0.2 },
    { date: '2026-09-07', pct: 1.0 },
    { date: '2026-09-14', pct: 3.2 },
    { date: '2026-09-21', pct: 8.0 },
    { date: '2026-09-28', pct: 17.5 },
    { date: '2026-10-05', pct: 32.3 },
    { date: '2026-10-12', pct: 48.5 },
    { date: '2026-10-19', pct: 62.3 },
    { date: '2026-10-26', pct: 73.5 },
    { date: '2026-11-02', pct: 82.3 },
    { date: '2026-11-09', pct: 88.5 },
    { date: '2026-11-16', pct: 92.7 },
    { date: '2026-11-23', pct: 95.5 },
    { date: '2026-11-30', pct: 97.3 },
    { date: '2026-12-07', pct: 98.5 },
    { date: '2026-12-14', pct: 99.3 },
    { date: '2026-12-21', pct: 99.8 },
    { date: '2026-12-28', pct: 100 },
  ],
};
