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
  // `focus:`, not `focus-visible:` (rule 4's standalone-control carve-out, rule
  // 288(c)). Retry is frequently the ONLY focusable in its container — inside the
  // health chip's popover it is the sole control, so the dialog's focus trap seats
  // it with a SCRIPTED `.focus()`, which Firefox and desktop Safari routinely
  // decline to match `:focus-visible` against. Paired with `outline-none` that
  // left the one control in a modal with no visible indicator at all (#3525).
  const offset = isFill
    ? 'focus:ring-offset-neutral-surface'
    : 'focus:ring-offset-neutral-surface-raised';

  return (
    <div role={isFill ? 'alert' : 'status'} className={container}>
      <p className="text-sm text-semantic-critical">
        {message}{' '}
        <button
          type="button"
          className={`underline focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 ${offset}`}
          onClick={retry}
        >
          Retry
        </button>
      </p>
    </div>
  );
}
