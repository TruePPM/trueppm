/**
 * FlowAnalyticsPanel — methodology-neutral flow analytics on the board (ADR-0137,
 * issue 1188). Surfaces the ADR-0130 D1 read (`GET /projects/{id}/flow-metrics/`):
 * a cumulative flow diagram, a weekly throughput chart, and a cycle/lead-time
 * P50/P80/P95 stat strip.
 *
 * Collapsed by default (localStorage-persisted) so it never adds friction to the
 * board for a contributor who doesn't want it (VoC Priya). The historical
 * distributions are team-private (ADR-0104 `flow_metrics`, TEAM/TEAM): a
 * below-audience reader gets `flow_metrics_suppressed` and sees a content-free
 * wall (web-rule 165), never blurred numbers. In-audience, a legible caption makes
 * the "aggregate only — no individual breakdown" guarantee self-evident (VoC
 * Morgan/Priya), not buried in docs.
 *
 * Charts use Recharts with CSS-var color tokens (mirroring BurnChart) and
 * `isAnimationActive={false}` (reduced motion + deterministic tests). Each chart
 * carries an sr-only text summary so the data is reachable without seeing the SVG
 * (web-rule 176).
 */
import { type ReactNode, useCallback, useState } from 'react';
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

import { formatShortDate } from '@/features/sprints/sprintMath';
import { type CfdCounts, type FlowMetrics, useFlowMetrics } from '@/hooks/useSprints';

interface Props {
  projectId: string;
}

/** CFD bands in board order; rendered downstream-first so Complete sits at the base. */
const CFD_BANDS: { key: keyof CfdCounts; label: string; color: string }[] = [
  { key: 'BACKLOG', label: 'Backlog', color: 'var(--color-neutral-border)' },
  { key: 'NOT_STARTED', label: 'To Do', color: 'var(--color-neutral-text-disabled)' },
  { key: 'IN_PROGRESS', label: 'In Progress', color: 'var(--color-brand-primary)' },
  { key: 'REVIEW', label: 'Review', color: 'var(--color-semantic-at-risk)' },
  { key: 'COMPLETE', label: 'Complete', color: 'var(--color-semantic-on-track)' },
];

const AXIS_TICK = {
  fill: 'var(--color-neutral-text-secondary)',
  fontSize: 11,
} as const;

function usePersistentDisclosure(key: string, fallback: boolean) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : raw === 'true';
    } catch {
      return fallback;
    }
  });
  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(key, String(next));
      } catch {
        /* storage may be unavailable (private mode) — in-memory state still works */
      }
      return next;
    });
  }, [key]);
  return [open, toggle] as const;
}

export function FlowAnalyticsPanel({ projectId }: Props) {
  // Collapsed by default for everyone — the board stays uncluttered until a user
  // opts in (VoC Priya). Only fetch once expanded, so a closed panel costs nothing.
  const [open, toggle] = usePersistentDisclosure(`tppm.board.flowPanel.${projectId}`, false);
  const { data, isLoading, isError } = useFlowMetrics(projectId, { enabled: open });

  const bodyId = `flow-analytics-body-${projectId}`;
  return (
    <section aria-label="Flow analytics" className="border-b border-neutral-border/60 bg-neutral-surface">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={bodyId}
        data-testid="flow-analytics-toggle"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary hover:bg-chrome-row-hover focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
      >
        <span aria-hidden="true" className={`transition-transform ${open ? 'rotate-90' : ''}`}>
          ▸
        </span>
        Flow analytics
        {!open && (
          <span className="ml-2 font-normal normal-case text-neutral-text-disabled">
            <span aria-hidden="true">🔒 </span>team-private
          </span>
        )}
      </button>
      {open && (
        <div id={bodyId} className="px-3 pb-3" data-testid="flow-analytics-body">
          <PanelBody data={data} isLoading={isLoading} isError={isError} />
        </div>
      )}
    </section>
  );
}

function PanelBody({
  data,
  isLoading,
  isError,
}: {
  data: FlowMetrics | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  if (isError) {
    return (
      <p className="py-3 text-xs text-semantic-critical" data-testid="flow-analytics-error">
        Couldn&apos;t load flow analytics. Try again shortly.
      </p>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="grid grid-cols-1 gap-3 py-2 lg:grid-cols-3" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-36 animate-pulse rounded bg-neutral-surface-sunken" />
        ))}
      </div>
    );
  }
  if (data.flow_metrics_suppressed) {
    return <SuppressedWall />;
  }
  if (isEmpty(data)) {
    return (
      <p className="py-3 text-xs text-neutral-text-secondary" data-testid="flow-analytics-empty">
        Not enough completed work yet — flow metrics appear once cards start finishing.
      </p>
    );
  }

  return (
    <div data-testid="flow-analytics-charts">
      <p className="pb-2 text-xs text-neutral-text-disabled">
        <span aria-hidden="true">🔒 </span>Team-private · aggregate only — no individual breakdown
      </p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <CumulativeFlowChart cfd={data.cfd} />
        <ThroughputChart throughput={data.throughput} />
        <CycleLeadStrip cycle={data.cycle_time} lead={data.lead_time} windowDays={data.window_days} />
      </div>
      <DataIntegrityNote integrity={data.data_integrity} />
    </div>
  );
}

/** Matches the canonical content-free wall (web-rule 165), like PulseGatedWall. */
function SuppressedWall() {
  return (
    <div
      className="my-2 flex flex-col items-center gap-1 rounded-md border border-neutral-border bg-neutral-surface-raised p-4 text-center"
      data-testid="flow-metrics-suppressed"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
        <span aria-hidden="true">🔒 </span>Flow analytics
      </p>
      <p className="max-w-prose text-sm text-neutral-text-secondary">
        This team keeps its flow metrics private. Cycle time, throughput, and the cumulative flow
        diagram are shared with the team and their coach only — by the team&apos;s choice.
      </p>
    </div>
  );
}

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
          <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: band.color }} />
          {band.label}
        </li>
      ))}
    </ul>
  );
}

function CumulativeFlowChart({ cfd }: { cfd: FlowMetrics['cfd'] }) {
  const points = cfd.map((row) => ({ date: row.date, ...row.counts }));
  const last = cfd.at(-1)?.counts;
  const summary = last
    ? `Cumulative flow over ${cfd.length} days. Latest: ${last.COMPLETE} complete, ${last.REVIEW} in review, ${last.IN_PROGRESS} in progress, ${last.NOT_STARTED} to do, ${last.BACKLOG} in backlog.`
    : 'Cumulative flow diagram. No data in the window.';
  return (
    <ChartFrame title="Cumulative flow" summary={summary} footer={<CfdLegend />}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-neutral-border)" />
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

function ThroughputChart({ throughput }: { throughput: FlowMetrics['throughput'] }) {
  const total = throughput.reduce((sum, w) => sum + w.completed_count, 0);
  const summary = `Weekly throughput over ${throughput.length} weeks. ${total} items completed in total.`;
  return (
    <ChartFrame title="Throughput / week" summary={summary}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={throughput} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-neutral-border)" />
          <XAxis dataKey="week_start" tick={AXIS_TICK} tickFormatter={formatShortDate} minTickGap={20} tickLine={false} axisLine={false} />
          <YAxis tick={AXIS_TICK} width={28} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip labelFormatter={(d) => `Week of ${formatShortDate(String(d))}`} />
          <Bar
            dataKey="completed_count"
            name="Completed"
            fill="var(--color-semantic-on-track)"
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/**
 * The backend returns cycle/lead time as P50/P80/P95 day-count percentiles, not a
 * bucketed distribution — so this is a compact stat strip, not a histogram.
 */
function CycleLeadStrip({
  cycle,
  lead,
  windowDays,
}: {
  cycle: FlowMetrics['cycle_time'];
  lead: FlowMetrics['lead_time'];
  windowDays: number;
}) {
  const summary = `Cycle and lead time over ${windowDays} days. Cycle P50 ${fmtDays(cycle.p50)}, P80 ${fmtDays(cycle.p80)}, P95 ${fmtDays(cycle.p95)}. Lead P50 ${fmtDays(lead.p50)}, P80 ${fmtDays(lead.p80)}, P95 ${fmtDays(lead.p95)}.`;
  return (
    <figure className="m-0">
      <figcaption className="mb-1 text-xs font-medium text-neutral-text-secondary">
        Cycle &amp; lead time
      </figcaption>
      <p className="sr-only">{summary}</p>
      <table className="w-full text-xs" data-testid="cycle-lead-strip">
        <thead>
          <tr className="text-neutral-text-disabled">
            <th className="text-left font-normal" scope="col">
              <span className="sr-only">Metric</span>
            </th>
            <th className="text-right font-normal" scope="col">P50</th>
            <th className="text-right font-normal" scope="col">P80</th>
            <th className="text-right font-normal" scope="col">P95</th>
          </tr>
        </thead>
        <tbody className="text-neutral-text-primary">
          <StatRow label="Cycle" p={cycle} />
          <StatRow label="Lead" p={lead} />
        </tbody>
      </table>
    </figure>
  );
}

function StatRow({ label, p }: { label: string; p: FlowMetrics['cycle_time'] }) {
  return (
    <tr className="border-t border-neutral-border/50">
      <th scope="row" className="py-1 text-left font-medium text-neutral-text-secondary">
        {label}
      </th>
      <td className="py-1 text-right tppm-mono">{fmtDays(p.p50)}</td>
      <td className="py-1 text-right tppm-mono">{fmtDays(p.p80)}</td>
      <td className="py-1 text-right tppm-mono">{fmtDays(p.p95)}</td>
    </tr>
  );
}

function DataIntegrityNote({ integrity }: { integrity: FlowMetrics['data_integrity'] }) {
  const parts: string[] = [];
  if (integrity.bulk_moved_count > 0) parts.push(`${integrity.bulk_moved_count} bulk-moved`);
  if (integrity.backdated_count > 0) parts.push(`${integrity.backdated_count} backdated`);
  if (integrity.missing_transition_count > 0)
    parts.push(`${integrity.missing_transition_count} missing transitions`);
  if (parts.length === 0) return null;
  return (
    <p className="pt-2 text-xs text-neutral-text-disabled" data-testid="flow-data-integrity">
      <span aria-hidden="true">ⓘ </span>
      {parts.join(' · ')} — these may skew the figures above.
    </p>
  );
}

function fmtDays(n: number | null): string {
  return n === null ? '—' : `${n}d`;
}

function isEmpty(data: FlowMetrics): boolean {
  const noCycle = data.cycle_time.p50 === null;
  const noThroughput = data.throughput.every((w) => w.completed_count === 0);
  return noCycle && noThroughput;
}
