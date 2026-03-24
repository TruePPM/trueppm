import type { ShellStats } from '@/types';

export const FIXTURE_SHELL_STATS: ShellStats = {
  taskCount: 42,
  criticalPathCount: 3,
  monteCarlop80: '2026-11-03',
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
  lastSaved: new Date(Date.now() - 1000 * 60 * 2).toISOString(), // 2 minutes ago
  recalculatedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(), // 5 minutes ago
};
