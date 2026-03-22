import type { ShellStats } from '@/types';

export const FIXTURE_SHELL_STATS: ShellStats = {
  taskCount: 42,
  criticalPathCount: 3,
  monteCarlop80: '2026-11-03',
  atRiskCount: 2,
  criticalCount: 1,
  onlineUsers: 3,
  lastSaved: new Date(Date.now() - 1000 * 60 * 2).toISOString(), // 2 minutes ago
};
