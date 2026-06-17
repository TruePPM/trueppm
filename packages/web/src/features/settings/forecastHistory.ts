import type { InheritableSelectOption } from './components/InheritableSelectField';
import type { MCAttributionAudience } from '@/api/types';

/**
 * Attribution-audience options for the forecast-history settings group
 * (ADR-0144, issue 1232). Shared across the Workspace, Program, and Project settings
 * pages so the labels never fork. `ADMIN_OWNER` preserves today's behavior.
 */
export const MC_ATTRIBUTION_OPTIONS: ReadonlyArray<InheritableSelectOption<MCAttributionAudience>> =
  [
    { value: 'ADMIN_OWNER', label: 'Admins & owners' },
    { value: 'SCHEDULER_PLUS', label: 'Schedulers and above' },
    { value: 'NONE', label: 'No one' },
  ];

/** Help text shared by the attribution control on all three scopes. */
export const MC_ATTRIBUTION_HINT =
  'Who can see which member triggered each Monte Carlo run.';

/** Help text shared by the history toggle on all three scopes. */
export const MC_HISTORY_HINT =
  'Past forecast runs are retained so their distributions can be re-viewed.';
