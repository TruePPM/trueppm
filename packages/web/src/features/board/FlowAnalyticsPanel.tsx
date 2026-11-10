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
 * Charts (FlowCharts.tsx, lazy-loaded) use Recharts with CSS-var color tokens (mirroring BurnChart) and
 * `isAnimationActive={false}` (reduced motion + deterministic tests). Each chart
 * carries an sr-only text summary so the data is reachable without seeing the SVG
 * (web-rule 176).
 */
import { LockIcon } from '@/components/Icons';
import { type ReactNode, Suspense, lazy, useCallback, useState } from 'react';

import { ForecastHorizonHelp } from '@/features/sprints/ForecastHorizonHelp';
import { formatShortDate } from '@/features/sprints/sprintMath';
import {
  type FlowMetrics,
  type SprintForecast,
  useFlowMetrics,
  useSprintForecast,
} from '@/hooks/useSprints';
import type { BoardCadence } from '@/types';

// Recharts is the single heaviest dependency on the board route and the panel is
// collapsed by default, so the chart bodies load on first expansion (#1536). The
// disclosure button and the non-chart stat strip stay in the eager chunk.
const CumulativeFlowChart = lazy(() =>
  import('./FlowCharts').then((m) => ({ default: m.CumulativeFlowChart })),
);
const ThroughputChart = lazy(() =>
  import('./FlowCharts').then((m) => ({ default: m.ThroughputChart })),
);

/** Skeleton ghost matching a chart cell's footprint (web-rule 248). */
function ChartSkeleton() {
  return (
    <div
      className="h-36 motion-safe:animate-pulse rounded-card bg-neutral-surface-sunken"
      aria-hidden="true"
      data-testid="flow-chart-skeleton"
    />
  );
}

interface Props {
  projectId: string;
  /**
   * ADR-0164 board cadence. The throughput forecast card (issue 1280) renders only for
   * a continuous-flow board; a sprint board keeps its velocity Monte-Carlo forecast
   * (SprintForecastWidget / SprintForecastChips) and is left unaffected.
   */
  boardCadence?: BoardCadence;
}

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

export function FlowAnalyticsPanel({ projectId, boardCadence }: Props) {
  // Collapsed by default for everyone — the board stays uncluttered until a user
  // opts in (VoC Priya). Only fetch once expanded, so a closed panel costs nothing.
  const [open, toggle] = usePersistentDisclosure(`tppm.board.flowPanel.${projectId}`, false);
  const { data, isLoading, isError } = useFlowMetrics(projectId, { enabled: open });
  // Throughput forecast (ADR-0130 D3, issue 1280): the forward-looking answer a
  // continuous-flow team can't read off the historical charts — "finish in ~N weeks".
  // Fetched only for a continuous board and only once the panel is open, so a sprint
  // board (which keeps the velocity forecast) and a collapsed panel make no request.
  const isContinuous = boardCadence === 'continuous';
  const forecast = useSprintForecast(projectId, { enabled: open && isContinuous });

  const bodyId = `flow-analytics-body-${projectId}`;
  return (
    <section aria-label="Flow analytics" className="border-b border-neutral-border/60 bg-neutral-surface">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={bodyId}
        data-testid="flow-analytics-toggle"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary hover:bg-chrome-row-hover focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none"
      >
        <span aria-hidden="true" className={`transition-transform ${open ? 'rotate-90' : ''}`}>
          ▸
        </span>
        Flow analytics
        {!open && (
          <span className="ml-2 font-normal normal-case text-neutral-text-secondary">
            <LockIcon className="inline-block h-3 w-3 align-[-0.125em] mr-1" aria-hidden="true" />team-private
          </span>
        )}
      </button>
      {open && (
        <div id={bodyId} className="px-3 pb-3" data-testid="flow-analytics-body">
          {isContinuous && (
            <ThroughputForecastCard
              data={forecast.data}
              isLoading={forecast.isLoading}
              isError={forecast.isError}
            />
          )}
          <PanelBody data={data} isLoading={isLoading} isError={isError} />
        </div>
      )}
    </section>
  );
}

/**
 * Throughput forecast card (ADR-0130 D3, issue 1280) — the forward glance a
 * continuous-flow team can't get from the historical charts above: "at our recent
 * throughput, when does the remaining backlog finish?" It reads the same
 * `/sprint-forecast/` Monte-Carlo the project-overview SprintForecastWidget renders,
 * but headlines **P80** (the commit-safe estimate) framed forward — "~N weeks / by
 * <date>" — with P50 (optimistic) and P95 (conservative) in the detail line.
 *
 * The forecast is team-private behind the ADR-0104 `velocity` signal, an *independent*
 * gate from the charts' `flow_metrics` audience, so the card owns its suppressed state.
 */
function ThroughputForecastCard({
  data,
  isLoading,
  isError,
}: {
  data: SprintForecast | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  if (isError) {
    return (
      <ForecastFrame>
        <p className="text-xs text-semantic-critical" data-testid="throughput-forecast-error">
          Couldn&apos;t load the forecast. Try again shortly.
        </p>
      </ForecastFrame>
    );
  }
  if (isLoading || !data) {
    return (
      <ForecastFrame>
        <div className="h-5 w-2/3 motion-safe:animate-pulse rounded bg-neutral-surface-sunken" aria-hidden="true" />
      </ForecastFrame>
    );
  }
  if (data.velocity_suppressed) {
    return (
      <ForecastFrame>
        <p className="text-xs text-neutral-text-secondary" data-testid="throughput-forecast-suppressed">
          <LockIcon className="inline-block h-3 w-3 align-[-0.125em] mr-1" aria-hidden="true" />The throughput forecast is team-private (visible to the
          team).
        </p>
      </ForecastFrame>
    );
  }
  // Not enough completed-work history yet, or no remaining backlog to forecast — the
  // honest insufficiency state (no false precision, ADR-0130 D3). A continuous board
  // with no completions at all routes to `warming_up`; treat any non-ready shape the
  // same here, since the throughput framing is the only one this card speaks.
  if (data.status !== 'ready' || data.p50_date === null || data.p80_date === null) {
    return (
      <ForecastFrame>
        <p className="text-xs text-neutral-text-secondary" data-testid="throughput-forecast-insufficient">
          A throughput forecast needs at least 4 weeks of completed-work history
          {data.sample_count > 0 ? (
            <>
              {' '}
              (<span className="tppm-mono">{data.sample_count}</span> so far)
            </>
          ) : null}
          .
        </p>
      </ForecastFrame>
    );
  }

  const weeks = weeksFromNow(data.p80_date);
  return (
    <ForecastFrame>
      <p className="text-sm text-neutral-text-primary" data-testid="throughput-forecast-ready">
        At current throughput, the remaining backlog
        {data.remaining_count !== null ? (
          <>
            {' '}
            (<span className="tppm-mono">{data.remaining_count}</span> item
            {data.remaining_count === 1 ? '' : 's'})
          </>
        ) : null}{' '}
        finishes in{' '}
        <span className="font-semibold">
          ~<span className="tppm-mono">{weeks}</span> week{weeks === 1 ? '' : 's'}
        </span>{' '}
        — by <span className="tppm-mono font-semibold">{formatShortDate(data.p80_date)}</span>{' '}
        <span className="text-neutral-text-secondary">(P80) at the earliest</span>.
      </p>
      {/* #2495: this card headlines P80 more confidently than any other forecast
          surface, and the weekly-throughput sampler clamps each run's horizon — so
          the headline is a floor. Qualify it here, not only in the docs. */}
      <p className="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-neutral-text-secondary">
        <span>
          P50 <span className="tppm-mono">{formatShortDate(data.p50_date)}</span>
          {' · P80 '}
          <span className="tppm-mono">{formatShortDate(data.p80_date)}</span>
          {data.p95_date ? (
            <>
              {' · P95 '}
              <span className="tppm-mono">{formatShortDate(data.p95_date)}</span>
            </>
          ) : null}{' '}
          · Monte&nbsp;Carlo over weekly throughput —{' '}
          <strong className="font-medium">a floor, not a percentile</strong>
        </span>
        <ForecastHorizonHelp basis="throughput" />
      </p>
    </ForecastFrame>
  );
}

/** Card shell for the throughput forecast — mirrors the panel's small-label aesthetic
 * (a `<p>` pseudo-heading like SuppressedWall, not an `<h*>`, so the panel keeps a flat
 * heading order). The section's aria-label names the region for assistive tech. */
function ForecastFrame({ children }: { children: ReactNode }) {
  return (
    <section
      aria-label="Throughput forecast"
      data-testid="throughput-forecast"
      className="mb-3 rounded-card border border-neutral-border bg-neutral-surface-raised p-3"
    >
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
        Throughput forecast
      </p>
      {children}
    </section>
  );
}

/**
 * Whole weeks from today to an ISO date (yyyy-mm-dd), floored at 1 — the board-facing
 * "~N weeks" framing of the P80 completion date. The server paces the throughput
 * percentile onto the calendar as `today + round(weeks × 7)` days (ADR-0130 D3), so
 * dividing the day-gap back by 7 recovers that week count without a new API field.
 *
 * Both ends are taken at **UTC midnight** (web-rule 189: server forecast dates are UTC
 * and authoritative — never derive off a local `new Date(iso)`), so this soft gloss of
 * the authoritative P80 date never drifts a week with the viewer's timezone. The date
 * shown beside it stays the real figure; this is only its floored "~" framing.
 */
function weeksFromNow(isoDate: string): number {
  const target = Date.parse(`${isoDate}T00:00:00Z`);
  const now = new Date(Date.now());
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = (target - todayUtc) / 86_400_000;
  return Math.max(1, Math.round(days / 7));
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
          <div key={i} className="h-36 motion-safe:animate-pulse rounded-card bg-neutral-surface-sunken" />
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
        <LockIcon className="inline-block h-3 w-3 align-[-0.125em] mr-1" aria-hidden="true" />Team-private · aggregate only — no individual breakdown
      </p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Suspense fallback={<ChartSkeleton />}>
          <CumulativeFlowChart cfd={data.cfd} />
        </Suspense>
        <Suspense fallback={<ChartSkeleton />}>
          <ThroughputChart throughput={data.throughput} />
        </Suspense>
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
      className="my-2 flex flex-col items-center gap-1 rounded-card border border-neutral-border bg-neutral-surface-raised p-4 text-center"
      data-testid="flow-metrics-suppressed"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
        <LockIcon className="inline-block h-3 w-3 align-[-0.125em] mr-1" aria-hidden="true" />Flow analytics
      </p>
      <p className="max-w-prose text-sm text-neutral-text-secondary">
        This team keeps its flow metrics private. Cycle time, throughput, and the cumulative flow
        diagram are shared with the team and their coach only — by the team&apos;s choice.
      </p>
    </div>
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
