/**
 * The date value inside a Schedule outline grid cell, with its reconciliation
 * marker (ADR-0784, issue #2725).
 *
 * Rendering rules, and why:
 *
 * - **preview** → italic. The issue's explicit ask, and typographic rather than
 *   chromatic so it satisfies WCAG 1.4.1 on its own. The state resolves in a
 *   second or two, so a louder signal would flicker on every drag.
 * - **diverged** → `→Oct 16` in the at-risk tone. The ARROW is the non-color
 *   signal; the color is reinforcement, never the only carrier.
 * - The struck-through old value is added ONLY when the column is wide enough
 *   to hold it. `start`/`finish` default to 74px and floor at 60px
 *   (`MIN_COL_WIDTHS`), where `Oct 13 →Oct 16` cannot fit — but the columns are
 *   user-resizable, and a planner who widens them should get the full marker the
 *   issue describes. `widthPx` is already a prop, so this costs a comparison and
 *   no measurement.
 * - The full sentence is ALWAYS available regardless of width: on the cell's
 *   `title`, in its `aria-label` (see `cellAriaLabel`), and in the review
 *   strip's change list.
 *
 * This renders NO interactive element. The outline is a `treegrid` whose key
 * contract landed in #2727, and an acknowledge button per row would add a tab
 * stop per row and wreck keyboard traversal. Acknowledgement lives in the strip.
 */
import { fmtCellDate } from './reconcileCopy';
import type { ReconcileEntry } from './reconcileState';

/**
 * Width at or above which the struck-through old value also fits.
 *
 * "Oct 13 →Oct 16" is ~112px at 12px tabular-nums; 132 leaves room for the
 * cell's `pr-2` and a longer format (`2026-10-13` under the ISO date style).
 */
export const FULL_MARKER_MIN_WIDTH_PX = 132;

interface Props {
  /** The authoritative value now in the cache, or null/empty when unscheduled. */
  value: string | null | undefined;
  entry: ReconcileEntry | undefined;
  widthPx: number;
  /** Milestones render their date in Start and an em-dash in Finish. */
  fallback?: string;
}

export function DateCellValue({ value, entry, widthPx, fallback = '—' }: Props) {
  if (!value) return <>{fallback}</>;

  if (entry?.status === 'preview') {
    return <span className="italic">{fmtCellDate(value)}</span>;
  }

  if (entry?.status === 'diverged' && entry.actual) {
    const showOld = widthPx >= FULL_MARKER_MIN_WIDTH_PX;
    return (
      <span
        data-testid="reconcile-cell-diverged"
        className="inline-flex items-center gap-0.5 text-semantic-at-risk"
      >
        {/* `text-neutral-text-secondary`, NOT `-disabled`: the replaced date is
            meaningful content, and globals.css records `--neutral-text-disabled`
            at 2.70:1 — below the 4.5:1 that WCAG 1.4.3 requires for text (#2207). */}
        {showOld && (
          <s className="text-neutral-text-secondary">{fmtCellDate(entry.expected)}</s>
        )}
        <span aria-hidden="true">→</span>
        {fmtCellDate(entry.actual)}
      </span>
    );
  }

  if (entry?.status === 'rejected') {
    return (
      <span data-testid="reconcile-cell-rejected" className="text-semantic-critical">
        {fmtCellDate(value)}
      </span>
    );
  }

  return <>{fmtCellDate(value)}</>;
}
