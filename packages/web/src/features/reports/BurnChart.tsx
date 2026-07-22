import { useMemo, useRef, useState } from 'react';
import { useSprintBurndown } from '@/hooks/useSprints';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { forecastScopeCaption } from '@/features/sprints/sprintMath';
import { useBurnChart, type BurnVariant, type BurnMetric } from './hooks/useBurnChart';
import {
  describeBurnSeries,
  deriveProjectSeries,
  deriveSprintSeries,
  type ScopeChange,
} from './burnChartData';
import { BurnChartCanvas } from './BurnChartCanvas';
import { CompactBurnChart } from './CompactBurnChart';
import {
  ExportMenu,
  BurnChartControls,
  SprintTrendCallout,
  BurnLegend,
  ChartSkeleton,
  ChartEmpty,
} from './BurnChartChrome';

// Re-export the pure derive/format helpers and presentational tokens that live
// in the co-located modules so external consumers (and the unit tests) keep a
// single import surface at `./BurnChart`.
export {
  CHART_COLORS,
  scopeDotStyle,
  deriveSprintSeries,
  idealSlopeDenominator,
  idealRemainingAt,
} from './burnChartData';
export { BurnTooltip } from './BurnTooltip';

// ---------------------------------------------------------------------------
// Main BurnChart component
// ---------------------------------------------------------------------------
export interface BurnChartProps {
  /** Project id — used when not in sprint context. */
  projectId?: string;
  /** Sprint id — when set, switches to sprint-scoped burndown. */
  sprintId?: string;
  defaultVariant?: BurnVariant;
  /**
   * Compact mode (#1138) — renders ONLY a small single burndown line (no
   * variant radio, metric selector, date pickers, export, or section chrome)
   * at a fixed small size, plus a "N of M pts left" caption. Used in the board
   * sprint header. Requires `sprintId` (sprint context); a no-op fallback
   * renders nothing when no sprint data is available.
   */
  compact?: boolean;
}

export function BurnChart({
  projectId,
  sprintId,
  defaultVariant = 'burndown',
  compact = false,
}: BurnChartProps) {
  const [variant, setVariant] = useState<BurnVariant>(defaultVariant);
  const [metric, setMetric] = useState<BurnMetric>('tasks');
  const [since, setSince] = useState<string | undefined>();
  const [until, setUntil] = useState<string | undefined>();
  const chartRef = useRef<HTMLDivElement>(null);

  const isSprintCtx = !!sprintId;
  const itl = useIterationLabel(projectId);

  // --- Sprint data ---
  const sprintQuery = useSprintBurndown(sprintId ?? null);
  // Auto-derive sprint metric from committed_points so the series uses the right
  // unit even though the selector is hidden in sprint context.
  const sprintMetric: BurnMetric =
    isSprintCtx && sprintQuery.data
      ? (sprintQuery.data.sprint.committed_points ?? 0) > 0
        ? 'points'
        : 'tasks'
      : metric;
  const sprintResult = useMemo(() => {
    if (!isSprintCtx || !sprintQuery.data) return null;
    return deriveSprintSeries(sprintQuery.data.sprint, sprintQuery.data.snapshots, sprintMetric);
  }, [isSprintCtx, sprintQuery.data, sprintMetric]);

  // Forecast transparency (ADR-0102 §2): when the sprint has pending
  // (un-accepted) injections, the burn series reflects accepted scope only.
  // Shared copy so it can't word differently from the SprintPanel caption.
  const scopeCaption = isSprintCtx
    ? forecastScopeCaption(sprintQuery.data?.sprint.pending_count ?? 0)
    : null;

  // --- Project data ---
  const burnQuery = useBurnChart(isSprintCtx ? null : projectId, variant, metric, since, until);
  const projectResult = useMemo(() => {
    if (isSprintCtx || !burnQuery.data?.series.length) return null;
    return deriveProjectSeries(burnQuery.data.series, variant);
  }, [isSprintCtx, burnQuery.data, variant]);

  const isLoading = isSprintCtx ? sprintQuery.isLoading : burnQuery.isLoading;
  const isError = isSprintCtx ? sprintQuery.isError : burnQuery.isError;
  const points = isSprintCtx ? (sprintResult?.points ?? null) : (projectResult?.points ?? null);
  // Memoized so the `?? []` fallback keeps a stable identity — otherwise the
  // chart-summary useMemo (and the legend) would recompute every render.
  const scopeChanges = useMemo<ScopeChange[]>(
    () => (isSprintCtx ? (sprintResult?.scopeChanges ?? []) : (projectResult?.scopeChanges ?? [])),
    [isSprintCtx, sprintResult, projectResult],
  );
  const isEmpty = !isLoading && !isError && (!points || points.length === 0);

  // Metric selector: in sprint context, auto-derive and hide; in project context, show
  const effectiveMetric = isSprintCtx ? sprintMetric : metric;

  // Sprint trending / forecast
  const trendAhead = sprintResult?.trendAhead ?? null;
  const forecastDate = sprintResult?.forecastDate ?? null;

  // All-zero story points warning
  const allZeroPoints =
    !isLoading &&
    metric === 'points' &&
    !isSprintCtx &&
    !!points &&
    points.length > 0 &&
    points.every((p) => p.remaining === 0 && p.completed === 0);

  const today = new Date().toISOString().slice(0, 10);

  // Sprint-specific empty states: future sprint or active sprint with no snapshots yet.
  // deriveSprintSeries always generates a point per day, so isEmpty is always false for
  // sprint context — we need a separate gate to surface these UI states.
  const sprintHasNoRealData =
    isSprintCtx &&
    !!sprintQuery.data &&
    (sprintQuery.data.sprint.start_date > today || sprintQuery.data.snapshots.length === 0);
  const showEmpty = isEmpty || sprintHasNoRealData;

  // sr-only alternative for the chart SVG (issue 2175) — see describeBurnSeries.
  const chartSummary = useMemo(
    () =>
      points && points.length > 0
        ? describeBurnSeries(points, variant, effectiveMetric, scopeChanges, trendAhead)
        : '',
    [points, variant, effectiveMetric, scopeChanges, trendAhead],
  );

  // Export helpers
  const exportPng = async () => {
    const { toPng } = await import('html-to-image');
    if (!chartRef.current) return;
    const dataUrl = await toPng(chartRef.current, { pixelRatio: 2 });
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `burn-${variant}-${today}.png`;
    a.click();
  };

  const exportPdf = async () => {
    const { toPng } = await import('html-to-image');
    const { jsPDF } = await import('jspdf');
    if (!chartRef.current) return;
    const dataUrl = await toPng(chartRef.current, { pixelRatio: 2 });
    const img = new Image();
    img.src = dataUrl;
    await new Promise<void>((res) => {
      img.onload = () => res();
    });
    const pdf = new jsPDF({
      orientation: 'landscape',
      unit: 'px',
      format: [img.width, img.height],
    });
    pdf.addImage(dataUrl, 'PNG', 0, 0, img.width, img.height);
    pdf.save(`burn-${variant}-${today}.pdf`);
  };

  const heading = isSprintCtx ? `${itl.singular} Burndown` : 'Burn Chart';

  // -------------------------------------------------------------------------
  // Compact mode (#1138) — a stripped single-line burndown for the board
  // sprint header. Always sprint-scoped; renders a thin shell while loading.
  // -------------------------------------------------------------------------
  if (compact) {
    return (
      <CompactBurnChart
        sprint={sprintQuery.data?.sprint}
        metric={effectiveMetric}
        points={points}
        isLoading={isLoading}
        isError={isError}
        sprintHasNoRealData={sprintHasNoRealData}
        iterationLabel={itl.singular}
      />
    );
  }

  return (
    <section
      aria-labelledby="burn-chart-heading"
      className="rounded-card border border-neutral-border bg-neutral-surface flex flex-col"
    >
      {/* Card header */}
      <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3 border-b border-neutral-border">
        <h2 id="burn-chart-heading" className="text-sm font-semibold text-neutral-text-primary">
          {heading}
        </h2>
        <div className="flex items-center gap-2">
          {!isSprintCtx && (
            <select
              value={metric}
              onChange={(e) => setMetric(e.target.value as BurnMetric)}
              className="h-9 rounded-control border border-neutral-border bg-neutral-surface text-xs text-neutral-text-primary px-2 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
              aria-label="Metric"
            >
              <option value="tasks">Tasks</option>
              <option value="points">Story points</option>
            </select>
          )}
          <ExportMenu
            disabled={isLoading || showEmpty || isError}
            onExportPng={() => void exportPng()}
            onExportPdf={() => void exportPdf()}
          />
        </div>
      </div>

      {/* Controls row */}
      <BurnChartControls
        variant={variant}
        onVariantChange={setVariant}
        isSprintCtx={isSprintCtx}
        sprint={sprintQuery.data?.sprint}
        since={since}
        onSinceChange={setSince}
        until={until}
        onUntilChange={setUntil}
      />

      {/* Null story-points banner */}
      {allZeroPoints && (
        <div className="px-4 py-2 bg-semantic-info-bg border-b border-neutral-border flex items-center gap-2 text-xs text-neutral-text-secondary">
          <span aria-hidden="true">ⓘ</span>
          Most tasks have no story point estimates.{' '}
          <button
            type="button"
            onClick={() => setMetric('tasks')}
            className="underline text-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            Use task count
          </button>
        </div>
      )}

      {/* Chart area */}
      <div ref={chartRef} className="px-4 py-4">
        {isLoading && <ChartSkeleton />}
        {isError && (
          <div
            className="flex items-center justify-center gap-3 h-48 text-xs text-semantic-at-risk"
            aria-live="polite"
          >
            <span>⚠ Couldn&apos;t load chart data.</span>
            <button
              type="button"
              onClick={() => (isSprintCtx ? void sprintQuery.refetch() : void burnQuery.refetch())}
              className="underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              Retry
            </button>
          </div>
        )}
        {showEmpty && !isError && (
          <ChartEmpty
            isSprintCtx={isSprintCtx}
            sprint={sprintQuery.data?.sprint}
            iterationLabel={itl.singular}
          />
        )}
        {!isLoading && !isError && !showEmpty && points && (
          <p className="sr-only">{chartSummary}</p>
        )}
        {!isLoading && !isError && !showEmpty && points && (
          <BurnChartCanvas
            points={points}
            variant={variant}
            metric={effectiveMetric}
            scopeChanges={scopeChanges}
            today={today}
          />
        )}
      </div>

      {/* Sprint trending callout */}
      {isSprintCtx && trendAhead !== null && !isEmpty && !isLoading && (
        <SprintTrendCallout
          trendAhead={trendAhead}
          metric={effectiveMetric}
          forecastDate={forecastDate}
        />
      )}

      {/* Pending-scope forecast caveat (ADR-0102 §2) — shown whenever the sprint
          has un-accepted injections, regardless of trend/empty state. */}
      {isSprintCtx && scopeCaption && !isLoading && (
        <p className="px-4 py-2 border-t border-neutral-border text-xs text-neutral-text-secondary">
          <span aria-hidden="true">○</span> {scopeCaption}
        </p>
      )}

      {/* Legend */}
      {!isLoading && !isError && !isEmpty && (
        <BurnLegend variant={variant} scopeChanges={scopeChanges} />
      )}
    </section>
  );
}
