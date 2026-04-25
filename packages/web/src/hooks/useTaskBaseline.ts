import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/** Returned when the project has no active baseline. */
export interface BaselineAbsent {
  has_baseline: false;
}

/** Returned when the task was added after the baseline was taken. */
export interface BaselineTaskAbsent {
  has_baseline: true;
  in_baseline: false;
  baseline_name: string;
  baseline_taken_at: string;
}

/** Full comparison row when the task exists in the active baseline. */
export interface BaselineComparison {
  has_baseline: true;
  in_baseline: true;
  baseline_name: string;
  baseline_taken_at: string;
  has_cpm_dates: boolean;
  planned_start: string | null;
  planned_finish: string | null;
  planned_duration: number;
  planned_actual_start: string | null;
  planned_actual_finish: string | null;
  current_start: string | null;
  current_finish: string | null;
  current_duration: number;
  current_actual_start: string | null;
  current_actual_finish: string | null;
  /** Positive = current is later than planned (slipping). */
  start_delta_days: number | null;
  finish_delta_days: number | null;
  duration_delta: number;
}

export type TaskBaselineResult = BaselineAbsent | BaselineTaskAbsent | BaselineComparison;

/**
 * GET /api/v1/projects/{projectId}/tasks/{taskId}/baseline/
 *
 * Returns the active baseline vs current schedule comparison for a single
 * task.  The discriminant field `has_baseline` / `in_baseline` drives which
 * state the BaselineTab renders.
 */
export function useTaskBaseline(projectId: string, taskId: string) {
  return useQuery<TaskBaselineResult>({
    queryKey: ['task-baseline', projectId, taskId],
    queryFn: async () => {
      const res = await apiClient.get<TaskBaselineResult>(
        `/projects/${projectId}/tasks/${taskId}/baseline/`,
      );
      return res.data;
    },
  });
}
