import { useState } from 'react';
import { useSyncStatus, useRetrySync } from '@/hooks/useSyncStatus';
import { syncStatusPresentation, type SyncStatusKind } from './syncStatus';
import { SyncStatusModal } from './SyncStatusModal';

/**
 * Per-state visual treatment. Color is never the sole signal (WCAG 1.4.1) — each
 * state pairs its token color with a distinct icon *shape* and a text label:
 * - `synced`  — steady green dot, near-silent.
 * - `syncing` — brand spinner (motion-safe) + count.
 * - `offline` — calm orange cloud-off chip (semantic-at-risk) + pending count.
 * - `error`   — red alert chip (semantic-critical) + retry affordance.
 * - `stale`   — amber wifi-off chip (semantic-at-risk): live updates are down but
 *               writes still work, so it's degraded, not broken (#2053).
 */
const KIND_STYLE: Record<
  SyncStatusKind,
  { wrapper: string; icon: 'dot' | 'spinner' | 'cloud-off' | 'alert' | 'wifi-off'; iconColor: string }
> = {
  synced: {
    wrapper: 'text-neutral-text-secondary hover:bg-neutral-surface-raised',
    icon: 'dot',
    iconColor: 'text-semantic-on-track',
  },
  syncing: {
    wrapper: 'text-neutral-text-secondary hover:bg-neutral-surface-raised',
    icon: 'spinner',
    iconColor: 'text-brand-primary',
  },
  offline: {
    wrapper: 'bg-semantic-at-risk-bg text-semantic-at-risk hover:opacity-90',
    icon: 'cloud-off',
    iconColor: 'text-semantic-at-risk',
  },
  error: {
    wrapper: 'bg-semantic-critical-bg text-semantic-critical hover:opacity-90',
    icon: 'alert',
    iconColor: 'text-semantic-critical',
  },
  stale: {
    wrapper: 'bg-semantic-at-risk-bg text-semantic-at-risk hover:opacity-90',
    icon: 'wifi-off',
    iconColor: 'text-semantic-at-risk',
  },
};

function StateIcon({
  icon,
  colorClass,
}: {
  icon: 'dot' | 'spinner' | 'cloud-off' | 'alert' | 'wifi-off';
  colorClass: string;
}) {
  if (icon === 'dot') {
    return <span className={`h-2 w-2 shrink-0 rounded-full bg-current ${colorClass}`} aria-hidden="true" />;
  }
  if (icon === 'spinner') {
    return (
      <svg
        className={`h-3.5 w-3.5 shrink-0 motion-safe:animate-spin ${colorClass}`}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
    );
  }
  if (icon === 'cloud-off') {
    return (
      <svg
        className={`h-3.5 w-3.5 shrink-0 ${colorClass}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M18.8 18.8A5 5 0 0 0 18 9h-1.3A7 7 0 0 0 5.3 6.5" />
        <path d="M4 8a5 5 0 0 0-1 9.9" />
        <line x1="3" y1="3" x2="21" y2="21" />
      </svg>
    );
  }
  if (icon === 'wifi-off') {
    // Wi-Fi arcs with a slash — "live channel down" reads distinctly from the
    // cloud-off used for browser-offline, even though both share the amber token.
    return (
      <svg
        className={`h-3.5 w-3.5 shrink-0 ${colorClass}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <line x1="2" y1="2" x2="22" y2="22" />
        <path d="M8.5 16.5a5 5 0 0 1 7 0" />
        <path d="M2 8.82a15 15 0 0 1 4.17-2.65" />
        <path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76" />
        <path d="M16.85 11.25a10 10 0 0 1 2.22 1.68" />
        <path d="M5 13a10 10 0 0 1 5.24-2.76" />
        <line x1="12" y1="20" x2="12.01" y2="20" />
      </svg>
    );
  }
  return (
    <svg
      className={`h-3.5 w-3.5 shrink-0 ${colorClass}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

/**
 * SyncStatusBadge (issue 374) — a persistent, calm write-sync indicator in the
 * TopBar right cluster. Reflects the client-side write queue (ADR-0205): Synced,
 * Syncing N, Offline · N pending, or Sync error. Click opens a focus-trapped
 * modal with the pending-write list, last error, drain progress, and manual retry.
 *
 * Stays visible on mobile because offline trust matters *most* on a job site.
 */
export function SyncStatusBadge() {
  const [open, setOpen] = useState(false);
  const { status, pendingWrites, lastError, lastSyncAt, pendingPeak } = useSyncStatus();
  const retry = useRetrySync();

  const { label, aria } = syncStatusPresentation(status);
  const style = KIND_STYLE[status.kind];

  return (
    <>
      {/* Calm, polite announcement of the current state for assistive tech.
          aria-live keeps state changes audible without stealing focus. */}
      <span role="status" aria-live="polite" className="sr-only">
        {aria}
      </span>

      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={aria}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        className={[
          'inline-flex h-11 items-center gap-1.5 rounded-control px-2 md:h-8',
          'text-xs font-medium focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1',
          style.wrapper,
        ].join(' ')}
      >
        <StateIcon icon={style.icon} colorClass={style.iconColor} />
        {/* Label hidden below md (phones): the fixed-width right cluster can't
            compress (TopBar rule 174), so on a phone the word would push the tail
            of the cluster (bell, user menu) off the right edge (#1788). The icon +
            color keep the state legible, the aria-label + sr-only status carry the
            full word for assistive tech, and the button stays a ≥44px touch target
            via h-11. The word returns at md+ where there is room. */}
        <span className="hidden md:inline">{label}</span>
      </button>

      {open && (
        <SyncStatusModal
          status={status}
          pendingWrites={pendingWrites}
          lastError={lastError}
          lastSyncAt={lastSyncAt}
          pendingPeak={pendingPeak}
          onRetry={retry}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
