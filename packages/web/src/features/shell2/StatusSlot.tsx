import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useAuthStore } from '@/stores/authStore';
import { useDemoMode } from '@/hooks/useDemoMode';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useSyncStatus } from '@/hooks/useSyncStatus';
import { CheckIcon, WarningIcon } from '@/components/Icons';
import { Tooltip } from '@/components/Tooltip';
import { resolveStatusSlot, type StatusSlotModel } from './statusSlotModel';

/**
 * What the live region says for each state. Deliberately NOT the visible label:
 * the label carries counters ("Syncing 4…", "3 changes pending") that tick,
 * and a live region must announce discrete transitions, never a running number
 * (rule 220). Each phrase is a state, so an announcement fires once per change.
 */
const ANNOUNCEMENT: Record<StatusSlotModel['kind'], string> = {
  offline: 'You are offline. Changes will sync when you reconnect.',
  session: 'Your session has expired.',
  demo: 'This is a read-only demo.',
  'rate-limit': 'API rate limiting is off on this server.',
  'sync-error': 'Some changes failed to save.',
  'sync-stale': 'Live updates are paused.',
  syncing: 'Syncing changes.',
  synced: 'All changes synced.',
};

/**
 * The shell's ONE status pill. Replaces the stackable status-only banners of the
 * v1 shell (offline, rate-limit) and the sync badge with a single slot that shows
 * the highest-priority condition and folds the rest behind "+N". Bars that carry
 * an ACTION (the signed-out "Sign in again" bar, the demo-mode controls) stay
 * mounted by `AppShell2`; this slot only states.
 *
 * The live region is a permanently mounted `sr-only` element separate from the
 * visible pill (rule 335): it is in the tree from first paint, so a change is
 * announced reliably, and it is never a child of the "+N" button, where ARIA
 * would make it presentational.
 */
export function StatusSlot() {
  const online = useOnlineStatus();
  const sessionExpired = useAuthStore((s) => s.sessionExpired);
  const sessionReadOnly = useAuthStore((s) => s.sessionExpiredReadOnly);
  const { isDemoReadOnly } = useDemoMode();
  const { user } = useCurrentUser();
  const isOperator = user?.is_workspace_operator === true;
  const { data: health } = useSystemHealth({ poll: false, enabled: isOperator });
  const { status: sync } = useSyncStatus();

  const model = resolveStatusSlot({
    online,
    sessionExpired,
    sessionReadOnly,
    demoReadOnly: isDemoReadOnly,
    // Strict `=== false`: an unresolved health read is "unknown", not "off" (rule 392).
    rateLimitDisabled: isOperator && health?.security?.rate_limiting_enabled === false,
    sync,
  });

  const warn = model.tone === 'warn';
  const pill = (
    <span
      data-testid="shell2-status-slot"
      data-kind={model.kind}
      aria-hidden="true"
      className={[
        'inline-flex h-7 max-w-[260px] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs whitespace-nowrap',
        warn ? 'bg-p1-risk-tint text-p1-risk-text' : 'text-p1-text-2',
      ].join(' ')}
    >
      {warn ? (
        <WarningIcon className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <CheckIcon className="h-3.5 w-3.5 shrink-0 text-p1-ok" />
      )}
      <span className="truncate">{model.label}</span>
      {model.more > 0 && (
        <span className="rounded-full bg-p1-surface-1 px-1.5 font-mono text-xs leading-4 text-p1-text-1">
          +{model.more}
        </span>
      )}
    </span>
  );

  const folded = model.more > 0 ? ` ${model.more} more: ${model.folded.join(', ')}.` : '';

  return (
    <>
      <span role="status" className="sr-only">
        {ANNOUNCEMENT[model.kind]}
        {folded}
      </span>
      {model.more > 0 ? (
        // "+N" is an abbreviation (rule 287): the folded conditions are reachable by
        // hover, focus and touch through the shared Tooltip. 44px target around a
        // 28px pill (rules 5, 330): sized, not inset — the top bar does not clip.
        <Tooltip content={model.folded.join(' · ')} describe={false}>
          <button
            type="button"
            aria-label={`${model.label}; ${model.more} more`}
            className="relative rounded-full before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-full before:min-w-[44px] before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus focus-visible:ring-offset-2 focus-visible:ring-offset-p1-surface-1"
          >
            {pill}
          </button>
        </Tooltip>
      ) : (
        pill
      )}
    </>
  );
}
