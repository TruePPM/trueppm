import type { TaskStatus } from '@/types';
import { WarningIcon } from '@/components/Icons';
import type { WipState, WipTrend } from '../wip';
import { COLUMN_DOT_CLASS } from './columnTokens';

interface WipBadgeProps {
  count: number;
  limit: number | null | undefined;
}

/**
 * WIP-limit badge for board column headers (#232).
 *
 * Three visual bands per the spec:
 *   count < limit   → neutral (no warning chrome)
 *   count == limit  → at-risk amber, label `{N}/{limit} WIP`
 *   count >  limit  → critical red, label `{N}/{limit} — over WIP limit`
 *
 * `limit == null` falls back to a count-only neutral chip — fully
 * backwards compatible with projects that haven't configured WIP yet.
 */
export function WipBadge({ count, limit }: WipBadgeProps) {
  if (limit == null) {
    return (
      <span className="ml-1.5 text-xs text-neutral-text-disabled font-medium tppm-mono">
        {count}
      </span>
    );
  }
  if (count > limit) {
    return (
      <span
        className="ml-1.5 text-xs font-medium px-1 py-0.5 rounded-chip border bg-semantic-critical-bg border-semantic-critical/40 text-semantic-critical tppm-mono"
        aria-label={`${count} of ${limit} WIP limit, over limit`}
      >
        {count}/{limit} — over WIP limit
      </span>
    );
  }
  if (count >= limit) {
    return (
      <span
        className="ml-1.5 text-xs font-medium px-1 py-0.5 rounded-chip border bg-semantic-at-risk-bg border-semantic-at-risk/40 text-semantic-at-risk tppm-mono"
        aria-label={`${count} of ${limit} WIP limit, at limit`}
      >
        {count}/{limit} WIP
      </span>
    );
  }
  return (
    <span
      className="ml-1.5 text-xs font-medium px-1 py-0.5 rounded-chip border bg-neutral-surface-sunken border-neutral-border text-neutral-text-secondary tppm-mono"
      aria-label={`${count} of ${limit} WIP limit`}
    >
      {count}/{limit}
    </span>
  );
}

/**
 * Always-on WIP breach chip for a column header (issue 1188 / ADR-0130 D2).
 *
 * Unlike WipBadge (which shows the numeric N/limit only under the "Show WIP
 * limits" toggle), this renders whenever a limit is at/over breach — a breach is
 * a signal Alex needs to catch before the retro, not an opt-in detail. Color is
 * never the sole cue: the ⚠ glyph + text carry the meaning. The chip itself is
 * aria-hidden because the column's <h2> accessible name already announces the
 * breach, so a screen reader hears it once, not twice.
 */
export function WipBreachChip({ state }: { state: 'at' | 'over' }) {
  const cls =
    state === 'over'
      ? 'bg-semantic-critical-bg text-semantic-critical'
      : 'bg-semantic-at-risk-bg text-semantic-at-risk';
  return (
    <span
      aria-hidden="true"
      data-testid="wip-breach-chip"
      data-breach={state}
      className={`inline-flex items-center gap-0.5 rounded-chip px-1 py-0.5 text-xs font-semibold ${cls}`}
    >
      <WarningIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />
      {state === 'over' ? 'Over limit' : 'At limit'}
    </span>
  );
}

/**
 * Tiny WIP trend arrow for a column header (issue 1213, VoC Alex).
 *
 * The always-on WipBreachChip catches a column that is *already* at/over limit;
 * this catches the creep *before* it breaches by reading the recent slope of the
 * column's CFD occupancy (computed by `wipTrend()`). An arrow — not a sparkline —
 * because a single high-contrast glyph is WCAG-legible at header scale where a
 * ~2px sparkline bar is not, and the header only needs the one-bit direction
 * signal (the full curve lives in FlowAnalyticsPanel).
 *
 * Color is never the sole cue: the ▲/▼ orientation carries the direction and the
 * `aria-label` names it. Amber (`approaching`) is reserved for the actionable
 * "rising and about to tip" case; a rising column comfortably under its limit,
 * and any falling column, stay neutral. Unlike the breach chip this is *not*
 * announced by the column <h2> accessible name (it's net-new information), so the
 * span carries `role="img"` + a label rather than being aria-hidden.
 */
export function WipTrendArrow({ trend }: { trend: WipTrend }) {
  const rising = trend.direction === 'rising';
  const cls = trend.approaching ? 'text-semantic-at-risk' : 'text-neutral-text-secondary';
  const label = rising
    ? trend.approaching
      ? 'trending up toward WIP limit'
      : 'trending up'
    : 'trending down';
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="wip-trend-arrow"
      data-trend={trend.direction}
      data-approaching={trend.approaching ? 'true' : 'false'}
      className={`text-xs font-semibold leading-none ${cls}`}
    >
      <span aria-hidden="true">{rising ? '▲' : '▼'}</span>
    </span>
  );
}

/** A stub breaches when its column is at or over the configured WIP limit. */
function isBreached(band: WipState): boolean {
  return band === 'at' || band === 'over';
}

/**
 * Pair the `-bg` pill fill with the matching full semantic token for text +
 * border (rule 8b) — `bg-semantic-critical text-white` failed WCAG 1.4.3 in dark
 * mode (white on the critical red-400 fill is approx 2.8:1). The `-bg` tints are
 * pre-computed per-mode in globals.css so the badge stays AA in both themes. An
 * empty stub drops the fill entirely for a dashed hollow ring (folded ≠ empty,
 * #1697).
 */
function stubBadgeClass(wipBand: WipState, isEmpty: boolean): string {
  if (isEmpty) return 'border-dashed border-neutral-border text-neutral-text-secondary';
  if (wipBand === 'over') {
    return 'bg-semantic-critical-bg text-semantic-critical border-semantic-critical/40';
  }
  if (wipBand === 'at') {
    return 'bg-semantic-at-risk-bg text-semantic-at-risk border-semantic-at-risk/40';
  }
  return 'bg-neutral-surface text-neutral-text-secondary border-neutral-border';
}

/** The stub's accessible name: column, count (or "empty"), breach, and whether
 *  it hides any of the current user's cards. */
function stubAriaLabel(opts: {
  label: string;
  count: number;
  wipBand: WipState;
  wipLimit: number | null;
  myCardCount: number;
}): string {
  const { label, count, wipBand, wipLimit, myCardCount } = opts;
  const occupancy = count === 0 ? 'empty' : `${count} task${count !== 1 ? 's' : ''}`;
  let breach = '';
  if (wipBand === 'over') breach = `, over WIP limit of ${wipLimit}`;
  else if (wipBand === 'at') breach = `, at WIP limit of ${wipLimit}`;
  const mine =
    myCardCount > 0 ? `, contains ${myCardCount} of your card${myCardCount !== 1 ? 's' : ''}` : '';
  return `Expand ${label} column, ${occupancy}${breach}${mine}`;
}

/**
 * Collapsed-column stub for the board header (issue 1459, ADR-0192 Part 2).
 *
 * A narrow rail standing in for a folded column: status dot, a label rotated
 * to read bottom-to-top, and a count badge. The whole stub is a button —
 * clicking it expands the column back to full width. A stub is a *lens* on the
 * column, not a place to hide a signal the expanded header would show, so three
 * signals survive the fold:
 *
 *  - **WIP breach** (#1695) — the breach tone (amber `at` / red `over`) and the
 *    `N/limit` ratio render **always**, independent of the "Show WIP limits"
 *    toggle, matching the expanded header's `WipBreachChip` invariant (rule 176
 *    extended to stubs). Only the *limit* portion of a non-breaching count obeys
 *    `showWip`. The band is computed via the shared `wipState()` helper so the
 *    stub never drifts from the header (issue 546).
 *  - **Folded ≠ empty** (#1697) — a populated stub shows a filled count pill; an
 *    empty column (0 cards) shows a dashed hollow "0" so an observer never has to
 *    guess whether a folded column holds work.
 *  - **Your cards inside** (#1696) — a quiet 2px brand left-edge accent when the
 *    stub holds ≥1 card assigned to the current user, so collapsing a column can
 *    never silently swallow your own work.
 *
 * The glyphs are `aria-hidden`; the button's accessible name carries the column,
 * count (or "empty"), any breach, and whether it hides the current user's cards.
 */
export function ColumnStub({
  label,
  status,
  count,
  wipBand,
  wipLimit,
  showWip,
  myCardCount,
  onExpand,
}: {
  label: string;
  status: TaskStatus;
  count: number;
  wipBand: WipState;
  wipLimit: number | null;
  showWip: boolean;
  myCardCount: number;
  onExpand: () => void;
}) {
  const dotClass = COLUMN_DOT_CLASS[status] ?? 'bg-neutral-text-disabled';
  const isEmpty = count === 0;
  const hasMyCards = myCardCount > 0;
  // The limit portion (`N/limit`) shows whenever the column breaches — a breach
  // is always visible on a stub (#1695) — or when "Show WIP limits" is on and a
  // limit exists. A non-breaching count with the toggle off renders the plain N.
  const showLimit = wipLimit != null && (isBreached(wipBand) || showWip);
  return (
    <button
      type="button"
      onClick={onExpand}
      title={`Expand ${label}`}
      data-testid={`column-stub-${status}`}
      data-wip-state={wipBand}
      data-has-my-cards={hasMyCards ? 'true' : undefined}
      aria-label={stubAriaLabel({ label, count, wipBand, wipLimit, myCardCount })}
      className={`h-full w-full py-2.5 flex flex-col items-center gap-2 bg-neutral-surface-sunken
        hover:bg-neutral-surface transition-colors
        focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset${
          hasMyCards ? ' border-l-2 border-l-brand-primary' : ''
        }`}
    >
      <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotClass}`} />
      <span
        aria-hidden="true"
        className="text-xs font-semibold text-neutral-text-primary whitespace-nowrap tracking-wide
          [writing-mode:vertical-rl] rotate-180"
      >
        {label}
      </span>
      <span
        aria-hidden="true"
        className={`tppm-mono tabular-nums text-xs font-bold min-w-[18px] px-1 py-px rounded-full border text-center ${stubBadgeClass(wipBand, isEmpty)}`}
      >
        {isEmpty ? '0' : showLimit ? `${count}/${wipLimit}` : count}
      </span>
    </button>
  );
}
