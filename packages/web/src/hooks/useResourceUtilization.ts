// Stub hook — returns fixture data until TanStack Query is wired in.
// Replace the body with a real useQuery call; the return type is stable.
//
// API: GET /api/v1/projects/{projectId}/utilization/?start={start}&end={end}
// HTTP 409 → schedule not run (no CPM dates)
// HTTP 403 → permission denied (role < SCHEDULER)

import type { UtilizationResponse } from '@/features/resource/resourceUtils';

export type UtilizationStatus = 'idle' | 'loading' | 'success' | 'schedule-not-run' | 'error';

export interface UseResourceUtilizationResult {
  data: UtilizationResponse | undefined;
  status: UtilizationStatus;
  error: Error | null;
}

const FIXTURE: UtilizationResponse = {
  project_id: 'fixture-project',
  window: { start: '2026-03-02', end: '2026-03-27' },
  resources: [
    {
      resource_id: 'r1',
      resource_name: 'Alice Johnson',
      max_units: '1.00',
      hours_per_day: 8.0,
      calendar_id: null,
      calendar_differs_from_project: false,
      days: {
        '2026-03-02': { hours: 8, tasks: ['t1'] },
        '2026-03-03': { hours: 8, tasks: ['t1'] },
        '2026-03-04': { hours: 8, tasks: ['t1'] },
        '2026-03-05': { hours: 8, tasks: ['t1'] },
        '2026-03-06': { hours: 8, tasks: ['t1'] },
        '2026-03-09': { hours: 12, tasks: ['t1', 't2'] }, // overallocated
        '2026-03-10': { hours: 7, tasks: ['t2'] },
        '2026-03-11': { hours: 7, tasks: ['t2'] },
      },
    },
    {
      resource_id: 'r2',
      resource_name: 'Bob Martinez',
      max_units: '1.00',
      hours_per_day: 6.0,
      calendar_id: 'cal-2',
      calendar_differs_from_project: true,
      days: {
        '2026-03-02': { hours: 6, tasks: ['t3'] },
        '2026-03-03': { hours: 6, tasks: ['t3'] },
        '2026-03-04': { hours: 6, tasks: ['t3'] },
        '2026-03-09': { hours: 5.5, tasks: ['t4'] },
        '2026-03-10': { hours: 6, tasks: ['t4'] },
      },
    },
    {
      resource_id: 'r3',
      resource_name: 'Carol Singh',
      max_units: '0.50',
      hours_per_day: 8.0,
      calendar_id: null,
      calendar_differs_from_project: false,
      days: {
        '2026-03-16': { hours: 4, tasks: ['t5'] },
        '2026-03-17': { hours: 4, tasks: ['t5'] },
        '2026-03-18': { hours: 4, tasks: ['t5'] },
        '2026-03-19': { hours: 4, tasks: ['t5'] },
        '2026-03-20': { hours: 4, tasks: ['t5'] },
      },
    },
  ],
  unassigned_task_count: 2,
};

export function useResourceUtilization(
  projectId: string | undefined,
  _start: string,
  _end: string,
): UseResourceUtilizationResult {
  void projectId;
  // Stub: real implementation uses useQuery with the utilization endpoint.
  // Distinct states to handle:
  //   response.ok && status 200  → { status: 'success', data }
  //   response.status === 409    → { status: 'schedule-not-run', data: undefined }
  //   response.status === 403    → { status: 'error', error: PermissionError }
  return { data: FIXTURE, status: 'success', error: null };
}
