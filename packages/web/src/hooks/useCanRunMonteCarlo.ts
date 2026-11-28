import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ROLE_SCHEDULER } from '@/lib/roles';

/** Standing explanation rendered where a Run control is withheld. */
export const MC_RUN_ROLE_NOTE = 'Only Schedulers and above can update the shared forecast.';

/**
 * Whether the caller may run a Monte Carlo simulation that updates the project's
 * shared forecast (Scheduler and above; a lower role's run is never stored).
 *
 * Presence follows the *settled* entitlement (rule 302): while the role is loading
 * or the lookup failed, assume rights — the server is the enforcement point, and a
 * control withheld from a Scheduler on every load costs more than one that is
 * briefly offered to a Viewer.
 */
export function useCanRunMonteCarlo(projectId: string | undefined): boolean {
  const { role, isLoading, isError } = useCurrentUserRole(projectId);
  if (isLoading || isError) return true;
  return role !== null && role >= ROLE_SCHEDULER;
}
