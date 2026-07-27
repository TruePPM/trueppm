import type { MonteCarloResult } from '@/types';
import { fmtUtcShort, fmtUtcLong } from '@/lib/formatUtcDate';
import { forecastFlatGuidance } from '@/lib/forecastFlatMessage';
import { Tooltip } from '@/components/Tooltip';
import { percentileExplanation } from '@/lib/percentileExplanation';

interface Props {
  result: MonteCarloResult;
  /**
   * Risk delta for P80 vs deterministic CPM finish in calendar days.
   * When positive, renders "(+Nd)" suffix on the P80 chip.
   * Omit or pass null/0 to suppress the suffix.
   */
  p80DeltaDays?: number | null;
}

/**
 * Timeline side of the Monte Carlo row.
 *
 * Renders three permanently-visible date chips — `P50: {date}` (green),
 * `P80: {date}` (amber), `P95: {date}` (red).
 *
 * No row-level popover. The original hover popover (plain-English headline +
 * collapse-case PERT hint) was opened by `mouseenter` on the row and positioned
 * itself above it, which blocked interaction with the unscheduled gutter sitting
 * directly above. It was replaced by a native `title`, which fixed the cursor
 * interference and introduced a different bug: `title` is invisible to keyboard
 * focus, unreachable on touch, and ~1s delayed (rules 22a/121/166).
 *
 * Now each percentile chip carries its own `Tooltip` (rule 287), reachable by
 * hover, focus, and tap. Per-chip rather than per-row because "P80" is the token
 * a reader cannot decode — an explanation attached to the whole row is not
 * attached to the thing that confused them, and the chips are individually
 * focusable so the keyboard path lands on each meaning in turn. The row keeps its
 * `aria-label` summary for assistive tech and no longer needs a `title`.
 *
 * The full distribution histogram lives in the `MonteCarloDetailPanel` (opened via the
 * "Details" button in `ScheduleForecastBar`), `MCResultPanel` (TopBar P80 pill), and
 * `MonteCarloSheet` (mobile).
 *
 * Chip text satisfies WCAG 1.4.1 — percentile boundaries are expressed as
 * labelled text, not colour alone.
 */
export function MonteCarloTimeline({ result, p80DeltaDays }: Props) {
  const { p50, p80, p95 } = result;
  const isCollapsed = p50 === p80 && p80 === p95;

  // Reason-aware guidance for a flat forecast (issue 1340) — not always "missing estimates".
  const title = isCollapsed
    ? `Every simulation finished on ${fmtUtcLong(p80)}. ${forecastFlatGuidance(result.forecastDiagnostic)}`
    : `8 in 10 simulations finish by ${fmtUtcLong(p80)}.`;

  const showDelta = typeof p80DeltaDays === 'number' && p80DeltaDays > 0;

  const chips = [
    { label: 'P50', pct: 50, iso: p50, border: 'border-semantic-on-track/40', text: 'text-semantic-on-track', suffix: null },
    { label: 'P80', pct: 80, iso: p80, border: 'border-semantic-at-risk/40',  text: 'text-semantic-at-risk',  suffix: showDelta ? `(+${p80DeltaDays}d)` : null },
    { label: 'P95', pct: 95, iso: p95, border: 'border-semantic-critical/40', text: 'text-semantic-critical', suffix: null },
  ] as const;

  return (
    <div
      aria-label={title}
      className="flex-1 min-w-0 flex items-center justify-end gap-1.5 px-3 overflow-hidden border-t border-neutral-border bg-neutral-surface"
    >
      {chips.map(({ label, pct, iso, border, text, suffix }) => (
        // When the forecast collapsed to a single date, all three chips read the
        // same and the percentile sentence explains nothing the reader is
        // actually confused about — the question is "why are these identical?".
        // Every chip therefore carries the reason-aware guidance instead, so the
        // answer is one hover away from whichever chip they landed on. That
        // guidance previously existed only in the row's `title`, i.e. nowhere a
        // keyboard or touch user could reach it.
        <Tooltip key={label} content={isCollapsed ? title : percentileExplanation(pct)}>
          <span
            className={`text-xs font-medium px-1.5 py-0.5 rounded-chip border ${border} ${text} bg-transparent whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1`}
          >
            {label}: {fmtUtcShort(iso)}{suffix ? ` ${suffix}` : ''}
          </span>
        </Tooltip>
      ))}
    </div>
  );
}
