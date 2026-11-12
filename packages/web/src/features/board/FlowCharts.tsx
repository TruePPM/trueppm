/**
 * Recharts-backed charts for FlowAnalyticsPanel. Split into its own module so
 * the panel can `lazy()` it: Recharts (~109KB gzip) then loads on first expand
 * instead of on every Board/Today visit (#1536).
 */
import type { ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CHART_INITIAL_DIMENSION } from '@/lib/chartInitialDimension';

import { formatShortDate } from '@/features/sprints/sprintMath';
import type { CfdCounts, FlowMetrics } from '@/hooks/useSprints';

// DS-v2 tokens are bare RGB channel triples, so an SVG fill/stroke must wrap them
// in `rgb(var(--…))` and carry NO `--color-` prefix — a bare or `--color-`-prefixed
// ref resolves to nothing and the chart falls back to black-on-navy (issue 1791,
// the BurnChart bug this panel mirrors per web-rule 176).
/** CFD bands in board order; rendered downstream-first so Complete sits at the base. */
const CFD_BANDS: { key: keyof CfdCounts; label: string; color: string }[] = [
  { key: 'BACKLOG', label: 'Backlog', color: 'rgb(var(--neutral-border))' },
  { key: 'NOT_STARTED', label: 'To Do', color: 'rgb(var(--neutral-text-disabled))' },
  { key: 'IN_PROGRESS', label: 'In Progress', color: 'rgb(var(--brand-primary))' },
  { key: 'REVIEW', label: 'Review', color: 'rgb(var(--semantic-at-risk))' },
  { key: 'COMPLETE', label: 'Complete', color: 'rgb(var(--semantic-on-track))' },
];

const AXIS_TICK = {
  fill: 'rgb(var(--neutral-text-secondary))',
  fontSize: 11,
} as const;

/**
 * Wraps a chart's SVG in `aria-hidden` with an sr-only text summary as the real
 * accessible read (issue 2175). Any Recharts root rendered inside `children`
 * MUST pass `accessibilityLayer={false}` — Recharts 3.x's accessibility layer
 * (default on) injects its own focusable keyboard-nav overlay into the SVG,
 * which becomes an invisible focus trap under `aria-hidden` (axe
 * `aria-hidden-focus`, #3482; see BurnChartCanvas's docstring for the full
 * rationale).
 */
function ChartFrame({
  title,
  summary,
  children,
  footer,
}: {
  title: string;
  summary: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <figure className="m-0">
      <figcaption className="mb-1 text-xs font-medium text-neutral-text-secondary">{title}</figcaption>
      <p className="sr-only">{summary}</p>
      <div className="h-36" aria-hidden="true">
        {children}
      </div>
      {footer}
    </figure>
  );
}

/** Visible legend so the CFD bands are not distinguished by color alone (WCAG 1.4.1).
 * aria-hidden — the chart's sr-only summary already names every band for readers. */
function CfdLegend() {
  return (
    <ul aria-hidden="true" className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-neutral-text-disabled">
      {CFD_BANDS.map((band) => (
        <li key={band.key} className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-chip" style={{ backgroundColor: band.color }} />
          {band.label}
        </li>
      ))}
    </ul>
  );
}

export function CumulativeFlowChart({ cfd }: { cfd: FlowMetrics['cfd'] }) {
  const points = cfd.map((row) => ({ date: row.date, ...row.counts }));
  const last = cfd.at(-1)?.counts;
  const summary = last
    ? `Cumulative flow over ${cfd.length} days. Latest: ${last.COMPLETE} complete, ${last.REVIEW} in review, ${last.IN_PROGRESS} in progress, ${last.NOT_STARTED} to do, ${last.BACKLOG} in backlog.`
    : 'Cumulative flow diagram. No data in the window.';
  return (
    <ChartFrame title="Cumulative flow" summary={summary} footer={<CfdLegend />}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={CHART_INITIAL_DIMENSION}>
        <AreaChart
          data={points}
          margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
          accessibilityLayer={false}
        >
          <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="rgb(var(--neutral-border))" />
          <XAxis dataKey="date" tick={AXIS_TICK} tickFormatter={formatShortDate} minTickGap={28} tickLine={false} axisLine={false} />
          <YAxis tick={AXIS_TICK} width={28} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip labelFormatter={(d) => formatShortDate(String(d))} />
          {/* Render downstream-first so Complete forms the base of the stack. */}
          {[...CFD_BANDS].reverse().map((band) => (
            <Area
              key={band.key}
              type="monotone"
              dataKey={band.key}
              name={band.label}
              stackId="cfd"
              stroke={band.color}
              fill={band.color}
              fillOpacity={0.85}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function ThroughputChart({ throughput }: { throughput: FlowMetrics['throughput'] }) {
  const total = throughput.reduce((sum, w) => sum + w.completed_count, 0);
  const summary = `Weekly throughput over ${throughput.length} weeks. ${total} items completed in total.`;
  return (
    <ChartFrame title="Throughput / week" summary={summary}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={CHART_INITIAL_DIMENSION}>
        <BarChart
          data={throughput}
          margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
          accessibilityLayer={false}
        >
          <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="rgb(var(--neutral-border))" />
          <XAxis dataKey="week_start" tick={AXIS_TICK} tickFormatter={formatShortDate} minTickGap={20} tickLine={false} axisLine={false} />
          <YAxis tick={AXIS_TICK} width={28} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip labelFormatter={(d) => `Week of ${formatShortDate(String(d))}`} />
          <Bar
            dataKey="completed_count"
            name="Completed"
            fill="rgb(var(--semantic-on-track))"
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
