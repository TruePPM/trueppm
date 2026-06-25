import type { MonteCarloResult } from '@/types';
import { fmtUtcShort, fmtUtcLong } from '@/lib/formatUtcDate';

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
 * No popover. The previous hover popover (plain-English headline +
 * collapse-case PERT hint) was opened by `mouseenter` on the row and
 * positioned itself above the row, which blocked interaction with the
 * unscheduled gutter sitting directly above. The popover's only
 * persona-aligned content was Janet's "8 in 10 simulations finish by"
 * headline, and Janet rarely opens the schedule view at all. The browser-
 * native `title` attribute carries the same plain-English explanation on
 * lingering hover without intercepting cursor traffic.
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

  const title = isCollapsed
    ? `Every simulation finished on ${fmtUtcLong(p80)}. Add PERT estimates (optimistic / most-likely / pessimistic durations) on tasks to see a distribution.`
    : `8 in 10 simulations finish by ${fmtUtcLong(p80)}.`;

  const showDelta = typeof p80DeltaDays === 'number' && p80DeltaDays > 0;

  const chips = [
    { label: 'P50', iso: p50, border: 'border-semantic-on-track/40', text: 'text-semantic-on-track', suffix: null },
    { label: 'P80', iso: p80, border: 'border-semantic-at-risk/40',  text: 'text-semantic-at-risk',  suffix: showDelta ? `(+${p80DeltaDays}d)` : null },
    { label: 'P95', iso: p95, border: 'border-semantic-critical/40', text: 'text-semantic-critical', suffix: null },
  ] as const;

  return (
    <div
      title={title}
      aria-label={title}
      className="flex-1 min-w-0 flex items-center justify-end gap-1.5 px-3 overflow-hidden border-t border-neutral-border bg-neutral-surface"
    >
      {chips.map(({ label, iso, border, text, suffix }) => (
        <span
          key={label}
          className={`text-xs font-medium px-1.5 py-0.5 rounded-chip border ${border} ${text} bg-transparent whitespace-nowrap`}
        >
          {label}: {fmtUtcShort(iso)}{suffix ? ` ${suffix}` : ''}
        </span>
      ))}
    </div>
  );
}
