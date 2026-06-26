import type { ForecastDiagnostic, ForecastReason } from '@/types';

/** Wire shape of `forecast_diagnostic` as the API returns it (snake_case). */
export interface ForecastDiagnosticWire {
  deterministic: boolean;
  reason: ForecastReason | null;
  tasks_total: number;
  tasks_with_variance: number;
  tasks_pending_approval: number;
  agile_tasks_without_velocity: number;
}

/**
 * Map the snake_case `forecast_diagnostic` payload to the camelCase {@link ForecastDiagnostic}
 * (ADR-0028). Shared by the run and latest hooks so the two never drift; returns
 * `undefined` for a legacy payload that predates the field.
 */
export function mapForecastDiagnostic(wire: ForecastDiagnosticWire | undefined): ForecastDiagnostic | undefined {
  if (!wire) return undefined;
  return {
    deterministic: wire.deterministic,
    reason: wire.reason,
    tasksTotal: wire.tasks_total,
    tasksWithVariance: wire.tasks_with_variance,
    tasksPendingApproval: wire.tasks_pending_approval,
    agileTasksWithoutVelocity: wire.agile_tasks_without_velocity,
  };
}

/** The original, generic guidance — still correct for a genuine missing-estimate case. */
const MISSING_ESTIMATES =
  'Add PERT estimates (optimistic / most-likely / pessimistic durations) on tasks to see a distribution.';

/**
 * Actionable guidance explaining why a Monte Carlo forecast collapsed to a single
 * flat date.
 *
 * Centralizes the copy so the histogram, timeline, and sensitivity surfaces agree,
 * and — crucially — reflects the *server-computed* reason (issue 1340) instead of the old
 * hard-coded "add PERT estimates". That blanket message misled every user whose
 * forecast was flat for a different cause: estimates present but withheld pending
 * approval, agile work with no velocity history, work off the critical path, or
 * simply nothing committed. A legacy payload without the diagnostic (`undefined`
 * basis, e.g. a cache-expired run) falls back to the generic guidance.
 */
export function forecastFlatGuidance(basis: ForecastDiagnostic | undefined): string {
  if (!basis) return MISSING_ESTIMATES;
  switch (basis.reason) {
    case 'no_committed_tasks':
      return 'There are no committed tasks to forecast — move work out of the backlog or add tasks.';
    case 'all_complete':
      return 'All committed work is complete, so there is nothing left to forecast.';
    case 'estimates_off_critical_path':
      return "Estimated tasks aren't on the critical path, so they don't move the finish date.";
    case 'estimates_pending_approval': {
      const n = basis.tasksPendingApproval;
      return n === 1
        ? '1 task estimate is awaiting approval — approve it to fold its range into the forecast.'
        : `${n} task estimates are awaiting approval — approve them to fold their range into the forecast.`;
    }
    case 'no_velocity_history':
      return 'Close a sprint to build the velocity history this agile forecast samples from.';
    case 'no_estimates':
    default:
      return MISSING_ESTIMATES;
  }
}
