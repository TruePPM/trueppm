import type { ReactNode } from 'react';

export interface QueryErrorStateProps {
  /** Short failure message — defaults to a generic load error. */
  message?: ReactNode;
  /**
   * Retry handler. Defaults to a full page reload (matching the historical
   * Grid/Schedule banners). Pass a query `refetch` when the host hook exposes
   * one so the retry re-runs just the failed request instead of the whole app.
   */
  onRetry?: () => void;
  /**
   * `fill` (default) centers in a full-height surface — for whole-page/whole-pane
   * failures (Board, Grid, Schedule). `inline` renders a compact bordered card
   * sized to sit inside a section placeholder (Overview widgets).
   */
  variant?: 'fill' | 'inline';
  /** Extra container classes. */
  className?: string;
}

/**
 * Shared "couldn't load — Retry" state for TanStack Query fetch failures
 * (issue #1764).
 *
 * Single source for the error-banner-with-retry that Grid and Schedule grew
 * inline. Consolidating it means Board and Project Overview — which previously
 * swallowed fetch errors and rendered as empty/perpetual-skeleton — surface a
 * failure identically to every other primary surface, so users and support can
 * tell "the app is broken" from "there's nothing here yet."
 *
 * `role="alert"` announces the failure to assistive tech; the Retry control is a
 * real button with a visible focus ring.
 */
export function QueryErrorState({
  message = "Couldn't load data.",
  onRetry,
  variant = 'fill',
  className = '',
}: QueryErrorStateProps) {
  const retry = onRetry ?? (() => window.location.reload());
  const isFill = variant === 'fill';

  // `fill` is the whole surface the user navigated to — a dead page is an
  // assertive alert. `inline` is one widget on a still-working page, so it
  // announces politely (role="status") to avoid four widgets all interrupting
  // each other on a total outage. Offset color tracks the container surface so
  // the focus ring's gap renders in the right background. (frontend rule: query
  // fetch errors use this component, never an empty/skeleton state — #1764.)
  const container = isFill
    ? `flex h-full items-center justify-center bg-neutral-surface ${className}`
    : `flex min-h-24 items-center justify-center rounded-card border border-neutral-border bg-neutral-surface-raised px-4 py-6 ${className}`;
  const offset = isFill
    ? 'focus-visible:ring-offset-neutral-surface'
    : 'focus-visible:ring-offset-neutral-surface-raised';

  return (
    <div role={isFill ? 'alert' : 'status'} className={container}>
      <p className="text-sm text-semantic-critical">
        {message}{' '}
        <button
          type="button"
          className={`underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 ${offset}`}
          onClick={retry}
        >
          Retry
        </button>
      </p>
    </div>
  );
}
