import { useRef, useState } from 'react';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import type { BurnVariant, BurnMetric } from './hooks/useBurnChart';
import { useBurnChartData } from './useBurnChartData';
import { useBurnChartExport } from './useBurnChartExport';
import { BurnChartBody } from './BurnChartBody';
import { CompactBurnChart } from './CompactBurnChart';
import { ExportMenu, BurnChartControls, SprintTrendCallout, BurnLegend } from './BurnChartChrome';

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
import { RadioDotIcon } from '@/components/Icons';
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
  const chartRef = useRef<HTMLDivElement>(null);
  const itl = useIterationLabel(projectId);
  const d = useBurnChartData({ projectId, sprintId, variant, metric });
  const { exportPng, exportPdf } = useBurnChartExport(chartRef, variant, d.today);

  // Compact mode (#1138) — a stripped single-line burndown for the board sprint
  // header. Always sprint-scoped; renders a thin shell while loading.
  if (compact) {
    return (
      <CompactBurnChart
        sprint={d.sprint}
        metric={d.effectiveMetric}
        points={d.points}
        isLoading={d.isLoading}
        isError={d.isError}
        sprintHasNoRealData={d.sprintHasNoRealData}
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
          {d.isSprintCtx ? `${itl.singular} Burndown` : 'Burn Chart'}
        </h2>
        <div className="flex items-center gap-2">
          {!d.isSprintCtx && (
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
            disabled={d.isLoading || d.showEmpty || d.isError}
            onExportPng={() => void exportPng()}
            onExportPdf={() => void exportPdf()}
          />
        </div>
      </div>

      {/* Controls row */}
      <BurnChartControls
        variant={variant}
        onVariantChange={setVariant}
        isSprintCtx={d.isSprintCtx}
        sprint={d.sprint}
        since={d.since}
        onSinceChange={d.setSince}
        until={d.until}
        onUntilChange={d.setUntil}
      />

      {/* Null story-points banner */}
      {d.allZeroPoints && <NoEstimatesBanner onUseTaskCount={() => setMetric('tasks')} />}

      <BurnChartBody
        chartRef={chartRef}
        isLoading={d.isLoading}
        isError={d.isError}
        showEmpty={d.showEmpty}
        onRetry={d.refetch}
        isSprintCtx={d.isSprintCtx}
        sprint={d.sprint}
        iterationLabel={itl.singular}
        points={d.points}
        variant={variant}
        metric={d.effectiveMetric}
        scopeChanges={d.scopeChanges}
        today={d.today}
        chartSummary={d.chartSummary}
      />

      <BurnChartFooter
        isSprintCtx={d.isSprintCtx}
        isLoading={d.isLoading}
        isError={d.isError}
        isEmpty={d.isEmpty}
        trendAhead={d.trendAhead}
        metric={d.effectiveMetric}
        forecastDate={d.forecastDate}
        scopeCaption={d.scopeCaption}
        variant={variant}
        scopeChanges={d.scopeChanges}
      />
    </section>
  );
}

/**
 * Story points are opt-in. When a project never estimated, the points view is a
 * flat zero line that reads as "nothing happened" — so say what actually
 * happened and offer the one-click switch to task count.
 */
function NoEstimatesBanner({ onUseTaskCount }: { onUseTaskCount: () => void }) {
  return (
    <div className="px-4 py-2 bg-semantic-info-bg border-b border-neutral-border flex items-center gap-2 text-xs text-neutral-text-secondary">
      <span aria-hidden="true">ⓘ</span>
      Most tasks have no story point estimates.{' '}
      <button
        type="button"
        onClick={onUseTaskCount}
        className="underline text-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
      >
        Use task count
      </button>
    </div>
  );
}

interface BurnChartFooterProps {
  isSprintCtx: boolean;
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  trendAhead: number | null;
  metric: BurnMetric;
  forecastDate: string | null;
  scopeCaption: string | null;
  variant: BurnVariant;
  scopeChanges: Parameters<typeof BurnLegend>[0]['scopeChanges'];
}

/**
 * Everything below the chart: the sprint trend callout, the pending-scope
 * forecast caveat, and the legend. Each has its own visibility rule — notably
 * the scope caveat shows whenever the sprint has un-accepted injections,
 * regardless of trend or empty state (ADR-0102 §2).
 */
function BurnChartFooter({
  isSprintCtx,
  isLoading,
  isError,
  isEmpty,
  trendAhead,
  metric,
  forecastDate,
  scopeCaption,
  variant,
  scopeChanges,
}: BurnChartFooterProps) {
  const showTrend = isSprintCtx && trendAhead !== null && !isEmpty && !isLoading;
  const showCaption = isSprintCtx && scopeCaption && !isLoading;
  const showLegend = !isLoading && !isError && !isEmpty;
  return (
    <>
      {showTrend && (
        <SprintTrendCallout trendAhead={trendAhead} metric={metric} forecastDate={forecastDate} />
      )}
      {showCaption && (
        <p className="px-4 py-2 border-t border-neutral-border text-xs text-neutral-text-secondary">
          <RadioDotIcon
            aria-hidden="true"
            filled={false}
            className="mr-1 inline-block h-2.5 w-2.5 align-[-0.125em]"
          />
          {scopeCaption}
        </p>
      )}
      {showLegend && <BurnLegend variant={variant} scopeChanges={scopeChanges} />}
    </>
  );
}
