/** A frozen snapshot in the API's shape (#4803), shared by the status-update specs. */
import type { StatusUpdateSnapshot } from '@/api/types';

const metric = <T>(value: T, reason?: string) => ({
  value,
  as_of: '2026-11-20T09:00:00Z',
  definition: `def ${String(value)}`,
  ...(reason ? { reason } : {}),
});

export const SNAPSHOT: StatusUpdateSnapshot = {
  schema_version: 1,
  as_of: '2026-11-20T09:00:00Z',
  previous_seq: null,
  forecast: {
    p50: metric('2026-12-01'),
    p80: metric('2026-12-07'),
    cpm_finish: metric('2026-11-28'),
    cpm_finish_at_day_start: false,
    baseline_finish: '2026-12-01',
    baseline_finish_variance_days: metric(-3),
  },
  milestones: [
    {
      task_id: 'm1',
      short_id: 'T-1',
      name: 'Beta',
      cpm_finish: '2026-12-01',
      cpm_finish_at_day_start: false,
      baseline_finish: null,
      baseline_finish_at_day_start: null,
      variance_days: null,
    },
  ],
  milestones_truncated: false,
  counts: {
    completed_since_previous: metric(null, 'no_previous_update'),
    slipped_since_previous: metric(null, 'no_previous_update'),
  },
  risks: [],
  decisions: [],
};
