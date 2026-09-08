import type { ShellStats } from '@/types';

export const FIXTURE_SHELL_STATS: ShellStats = {
  taskCount: 42,
  criticalPathCount: 3,
  monteCarlop80: '2026-11-03',
  // The server's band for this fixture's counts with no manual override
  // (critical_count 1 → critical). A spec exercising the override sets this
  // independently of the counts — that divergence is the point (#3501).
  healthBand: 'critical',
  // 'derived' is the default on purpose: 'reported' would render the provenance
  // row in every spec that uses this fixture, so a spec asserting the row is
  // absent would pass for the wrong reason and one asserting it is present would
  // never have to set anything (#3525).
  healthBandSource: 'derived',
  atRiskCount: 2,
  criticalCount: 1,
  atRiskTasks: [
    { id: 't4', wbs: '1.3', name: 'Frontend Build' },
    { id: 't7', wbs: '2', name: 'Documentation' },
  ],
  criticalTasks: [
    { id: 't3', wbs: '1.2', name: 'Backend Implementation' },
  ],
  onlineUsers: 3,
};
