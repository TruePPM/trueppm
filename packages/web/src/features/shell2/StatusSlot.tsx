import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useAuthStore } from '@/stores/authStore';
import { useDemoMode } from '@/hooks/useDemoMode';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useSyncStatus } from '@/hooks/useSyncStatus';
import { CheckIcon, WarningIcon } from '@/components/Icons';
import { Tooltip } from '@/components/Tooltip';
import { resolveStatusSlot } from './statusSlot';

/**
 * The shell's ONE status pill. Replaces the four stackable banners of the v1
 * shell (session read-only, demo, offline, rate-limit) and the sync badge with
 * a single slot that shows the highest-priority condition and folds the rest
 * behind "+N" — the phone never loses 40% of its height to chrome again.
 *
 * It is a live region so a transition (going offline, a write failing) is
 * announced once; the label changes only on a discrete state change, never on
 * a tick, which keeps rule 220 honest.
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
      role="status"
      data-testid="shell2-status-slot"
      data-kind={model.kind}
      className={[
        'inline-flex h-7 max-w-[260px] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs whitespace-nowrap',
        warn ? 'bg-p1-risk-tint text-p1-risk-text' : 'text-p1-text-2',
      ].join(' ')}
    >
      {warn ? (
        <WarningIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <CheckIcon className="h-3.5 w-3.5 shrink-0 text-p1-ok" aria-hidden="true" />
      )}
      <span className="truncate">{model.label}</span>
      {model.more > 0 && (
        <>
          <span
            className="rounded-full bg-p1-surface-1 px-1.5 font-mono text-xs leading-4 text-p1-text-1"
            aria-hidden="true"
          >
            +{model.more}
          </span>
          <span className="sr-only">{` and ${model.more} more: ${model.folded.join(', ')}`}</span>
        </>
      )}
    </span>
  );

  // "+N" is an abbreviation (rule 287): the folded conditions are reachable by
  // hover, focus and touch through the shared Tooltip, not only by screen reader.
  return model.more > 0 ? (
    <Tooltip content={model.folded.join(' · ')} describe={false}>
      <button
        type="button"
        className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus focus-visible:ring-offset-2 focus-visible:ring-offset-p1-surface-1"
      >
        {pill}
      </button>
    </Tooltip>
  ) : (
    pill
  );
}
