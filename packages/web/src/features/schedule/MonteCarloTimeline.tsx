import type { MonteCarloResult } from '@/types';

interface Props {
  result: MonteCarloResult;
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
 * The full distribution histogram lives in dedicated MC views
 * (`MCResultPanel` from the TopBar P80 pill, `MonteCarloSheet` on mobile)
 * — surfaces where the user has explicitly asked for it.
 *
 * Chip text satisfies WCAG 1.4.1 — percentile boundaries are expressed as
 * labelled text, not colour alone.
 */
export function MonteCarloTimeline({ result }: Props) {
  const { p50, p80, p95 } = result;
  const isCollapsed = p50 === p80 && p80 === p95;

  const fmtShort = (iso: string) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
      new Date(iso),
    );
  const fmtLong = (iso: string) =>
    new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(iso));

  const title = isCollapsed
    ? `Every simulation finished on ${fmtLong(p80)}. Add PERT estimates (optimistic / most-likely / pessimistic durations) on tasks to see a distribution.`
    : `8 in 10 simulations finish by ${fmtLong(p80)}.`;

  const chips = [
    { label: 'P50', iso: p50, border: 'border-semantic-on-track/40', text: 'text-semantic-on-track' },
    { label: 'P80', iso: p80, border: 'border-semantic-at-risk/40',  text: 'text-semantic-at-risk'  },
    { label: 'P95', iso: p95, border: 'border-semantic-critical/40', text: 'text-semantic-critical' },
  ] as const;

  return (
    <div
      title={title}
      aria-label={title}
      className="flex-1 min-w-0 flex items-center justify-end gap-1.5 px-3 overflow-hidden border-t border-neutral-border bg-neutral-surface"
    >
      {chips.map(({ label, iso, border, text }) => (
        <span
          key={label}
          className={`text-xs font-medium px-1.5 py-0.5 rounded border ${border} ${text} bg-transparent whitespace-nowrap`}
        >
          {label}: {fmtShort(iso)}
        </span>
      ))}
    </div>
  );
}
