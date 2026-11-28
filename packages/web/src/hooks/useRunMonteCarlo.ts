import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { apiClient } from '@/api/client';
import { MonteCarloNotStoredError } from '@/lib/monteCarloRun';

interface RunOptions {
  n_simulations?: number;
}

/** `202` body of `POST /projects/{pk}/monte-carlo/` (#2273). */
interface MonteCarloRunQueued {
  queued: true;
  task_run_id: string;
  status: 'pending';
  n_simulations: number | null;
}

/** The subset of `GET /projects/{pk}/task-runs/{id}/` this hook reads. */
interface TaskRunPoll {
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
  result_summary: Record<string, unknown> | null;
}

/** Delay between task-run polls. A simulation is typically well under a second. */
export const MC_POLL_INTERVAL_MS = 500;
/**
 * Give up polling after this long. Above the server's 300 s task soft limit, so a
 * run the worker is still allowed to finish is never abandoned by the client.
 */
export const MC_POLL_TIMEOUT_MS = 330_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Rebuild a failed run's refusal as the axios error the synchronous endpoint used
 * to throw, so `describeWriteRefusal` / `isRetryableFailure` read the server's
 * message and status exactly as before the move to a worker. The worker stores
 * that body plus `status_code` on `result_summary` (TaskRunRefused).
 */
function refusalError(summary: Record<string, unknown> | null): AxiosError {
  const { status_code: rawStatus, ...body } = summary ?? {};
  const status = typeof rawStatus === 'number' ? rawStatus : 500;
  const config = { headers: {} } as InternalAxiosRequestConfig;
  const response: AxiosResponse = {
    data: Object.keys(body).length > 0 ? body : { detail: "Couldn't run the simulation." },
    status,
    statusText: '',
    headers: {},
    config,
  };
  return new AxiosError('Monte Carlo run failed', String(status), config, undefined, response);
}

/**
 * Run a Monte Carlo simulation for a project and resolve once it has finished.
 *
 * `POST /projects/{pk}/monte-carlo/` queues the simulation on a worker and answers
 * `202` with a task-run id (#2273); this polls `GET /projects/{pk}/task-runs/{id}/`
 * until the run succeeds or fails, so the mutation stays pending for the whole
 * simulation and every caller's `isPending` / `error` keep meaning what they did
 * when the endpoint was synchronous. A failed run rejects with the server's own
 * refusal (cycle, cap, busy worker) rebuilt as an axios error — see `refusalError`.
 *
 * On success, invalidates the `monte-carlo-latest` cache so every consumer of
 * `useMonteCarloResult` (Project Overview's Forecast widget, the Schedule MC row,
 * the mobile card, and the TopBar P80 pill) refetches in lockstep, and
 * `monte-carlo-history` so the new run prepends to the forecast drift history
 * (ADR-0175, #961) without a manual refresh.
 */
export function useRunMonteCarlo(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (opts: RunOptions = {}) => {
      if (!projectId) throw new Error('projectId is required to run Monte Carlo');
      const queued = await apiClient.post<MonteCarloRunQueued>(
        `/projects/${projectId}/monte-carlo/`,
        opts,
      );
      const runId = queued.data.task_run_id;
      const deadline = Date.now() + MC_POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(MC_POLL_INTERVAL_MS);
        const { data: run } = await apiClient.get<TaskRunPoll>(
          `/projects/${projectId}/task-runs/${runId}/`,
        );
        if (run.status === 'success') {
          // A run below Scheduler (or under the minimum run count) is computed but
          // never becomes the shared forecast. Stale role data can still offer the
          // control, so say so rather than letting the old forecast sit unchanged.
          if (run.result_summary?.stored_as_latest === false) {
            throw new MonteCarloNotStoredError();
          }
          return;
        }
        if (run.status === 'failed' || run.status === 'cancelled') {
          throw refusalError(run.result_summary);
        }
      }
      throw new Error('The simulation is taking longer than expected. Try again shortly.');
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['monte-carlo-latest', projectId] });
      void qc.invalidateQueries({ queryKey: ['monte-carlo-history', projectId] });
    },
  });
}
