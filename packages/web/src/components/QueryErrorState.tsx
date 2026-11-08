import { FOCUS_RING } from './page2/classes';
import { TYPE } from './page2/typeScale';
import type { ReactNode } from 'react';

interface BaseQueryErrorStateProps {
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

interface PageQueryErrorStateProps {
  /**
   * `page` — the shell v2 Pass 2 error state (rule 439): neutral, not red; it
   * says what still works and carries a short support code. Red is reserved for
   * critical and blocked (rule 440) — a failed request is neither, and a red
   * page told people their PROJECT was in trouble when only a fetch was.
   */
  variant: 'page';
  /** One sentence on what failed. */
  message?: string;
  /**
   * What still works while this is down — required, because "everything is
   * broken" is almost never true and is what a bare error implies.
   */
  stillWorks: string;
  /** Short code support can match to a log line — see `lib/supportCode`. */
  supportCode: string;
  onRetry?: () => void;
  className?: string;
}

export type QueryErrorStateProps = BaseQueryErrorStateProps | PageQueryErrorStateProps;

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
export function QueryErrorState(props: QueryErrorStateProps) {
  if (props.variant === 'page') return <PageQueryErrorState {...props} />;
  return <BaseQueryErrorState {...props} />;
}

function BaseQueryErrorState({
  message = "Couldn't load data.",
  onRetry,
  variant = 'fill',
  className = '',
}: BaseQueryErrorStateProps) {
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

/**
 * Pass 2 page error: left-aligned like the empty state, in ink and hairline
 * rather than red. `role="alert"` because the surface the person navigated to
 * did not load — the same reason the `fill` variant is assertive.
 */
function PageQueryErrorState({
  message = "This page couldn't load.",
  stillWorks,
  supportCode,
  onRetry,
  className = '',
}: PageQueryErrorStateProps) {
  const retry = onRetry ?? (() => window.location.reload());
  return (
    <div
      role="alert"
      data-testid="query-error-state"
      data-variant="page"
      className={`flex flex-col items-start gap-2 border-t border-p1-hairline py-8 text-left ${className}`}
    >
      <p className={`${TYPE.section} text-p1-text-1`}>{message}</p>
      <p className={`max-w-[480px] ${TYPE.body} text-p1-text-2`}>{stillWorks}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={retry}
          className={`inline-flex h-8 items-center rounded-md border border-p1-hairline-strong bg-p1-surface-1 px-3 font-medium text-p1-text-1 hover:bg-p1-surface-2 [@media(pointer:coarse)]:h-11 max-md:h-11 ${TYPE.body} ${FOCUS_RING}`}
        >
          Retry
        </button>
        <span className="text-xs text-p1-text-3">
          Support code <span className="font-mono tabular-nums text-p1-text-2">{supportCode}</span>
        </span>
      </div>
    </div>
  );
}
