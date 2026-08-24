import { WarningIcon } from '@/components/Icons';

interface Props {
  /** Name of the sprint that failed to close — it is still open. */
  sprintName: string;
  /** Lowercase iteration noun (e.g. "sprint" / "iteration") for supporting copy. */
  iterationLabel: string;
  /**
   * Server-authored explanation from `GET /sprints/{id}/close-request/`.
   * Already role-gated: raw failure text for project Admins, a complete summary
   * sentence for everyone else. Rendered verbatim — the client never derives
   * copy from `failure_reason`, so this banner cannot disagree with the API.
   */
  errorMessage: string;
  /** Number of attempts the server made before giving up. */
  attemptCount: number;
  /**
   * Re-open the close dialog. Omitted when a retry is not currently possible —
   * the sprint list may be mid-refetch, or a peer may have moved the sprint out
   * of ACTIVE — in which case the affordance is hidden rather than shown as a
   * control that would dismiss this banner and open nothing.
   */
  onRetry?: () => void;
  /** Dismiss the banner; the sprint stays open either way. */
  onDismiss: () => void;
}

/**
 * Terminal sprint-close failure (#2992).
 *
 * Closing a sprint returns 202 and completes on a Celery drain, so it can fail
 * minutes after the button was pressed — and until this banner existed it
 * failed *silently*: the sprint simply stayed ACTIVE with no error anywhere,
 * which is the whole defect #2894 opened the read route to fix and left
 * unsurfaced.
 *
 * Shown only for a **terminal** failure. A close that failed and is queued to
 * retry renders nothing, because the drain re-runs it about a minute later and
 * telling the user about a fault that self-heals before they can act is worse
 * than saying nothing.
 *
 * `role="alert"` (assertive, unlike the sibling RetroHandoffBanner's polite
 * `role="status"`) because this reverses a success the user was already told
 * about: the close toast fired on the 202. The two lead facts are therefore
 * that the close failed *and* that the sprint is still open — the second is the
 * one that changes what the user does next.
 *
 * Both buttons take `focus:` rings, not `focus-visible:`, per the rule-4/214
 * standalone-control carve-out. And neither carries a `bg-semantic-critical/N`
 * tint: this banner's own background is already a critical tint, so a tinted
 * control inside it composites twice and drops below 4.5:1 — see rule 336.
 */
export function SprintCloseFailedBanner({
  sprintName,
  iterationLabel,
  errorMessage,
  attemptCount,
  onRetry,
  onDismiss,
}: Props) {
  return (
    <div
      role="alert"
      className="mx-6 mt-2 rounded-card border border-semantic-critical/40 bg-semantic-critical-bg
        px-3 py-2 text-xs flex items-start justify-between gap-3"
    >
      <div className="flex items-start gap-2 min-w-0">
        <WarningIcon
          className="h-3.5 w-3.5 shrink-0 mt-0.5 text-semantic-critical"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="text-neutral-text-primary">
            <span className="font-medium">{sprintName}</span> didn&apos;t close, and the{' '}
            {iterationLabel} is still open.
          </p>
          <p className="text-neutral-text-secondary mt-0.5 break-words">{errorMessage}</p>
          <p className="text-neutral-text-secondary mt-0.5">
            {attemptCount === 1 ? 'Tried once.' : `Tried ${String(attemptCount)} times.`} Nothing
            else will be retried automatically.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="h-7 px-2.5 rounded text-xs font-medium
              border border-semantic-critical/40 bg-neutral-surface text-semantic-critical
              hover:bg-neutral-surface-raised
              focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
          >
            Try closing again
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss close failure"
          className="h-7 w-7 grid place-items-center rounded text-neutral-text-secondary
            hover:bg-neutral-surface-raised
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </div>
  );
}
