import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

export interface MyActiveSprintEntry {
  project_id: string;
  project_name: string;
  sprint: {
    id: string;
    name: string;
    short_id_display: string;
    start_date: string;
    finish_date: string;
    day: number;
    total: number;
    remaining_points: number;
    committed_points: number;
    /** ideal-now − remaining; positive = ahead, negative = behind. */
    trend_pts: number;
  };
  capacity_ratio: number;
  capacity_label: 'on_track' | 'at_risk' | 'over_capacity';
  velocity: {
    rolling_avg_points: number | null;
    forecast_range_low: number | null;
    forecast_range_high: number | null;
  };
}

/**
 * GET /api/v1/me/active-sprints/ — multi-team Sprints lens (#230).
 *
 * Returns one summary per project where the requesting user owns a
 * non-complete task in that project's active sprint. Pre-sorted server-
 * side by burndown deviation (most behind first).
 */
export function useMyActiveSprints() {
  return useQuery({
    queryKey: ['me', 'active-sprints'],
    queryFn: async () => {
      const res = await apiClient.get<MyActiveSprintEntry[]>('/me/active-sprints/');
      return res.data;
    },
  });
}
