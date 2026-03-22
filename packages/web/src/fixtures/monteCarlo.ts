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
};
