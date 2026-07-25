import type { RefObject } from 'react';
import type { BurnVariant, BurnMetric } from './hooks/useBurnChart';
import type { ScopeChange } from './burnChartData';
import { BurnChartCanvas } from './BurnChartCanvas';
import { ChartSkeleton, ChartEmpty } from './BurnChartChrome';

interface ChartErrorProps {
  onRetry: () => void;
}

function ChartError({ onRetry }: ChartErrorProps) {
  return (
    <div
      className="flex items-center justify-center gap-3 h-48 text-xs text-semantic-at-risk"
      aria-live="polite"
    >
      <span>⚠ Couldn&apos;t load chart data.</span>
      <button
        type="button"
        onClick={onRetry}
        className="underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
      >
        Retry
      </button>
    </div>
  );
}

interface BurnChartBodyProps {
  /** The node rasterized by PNG/PDF export — the chart area, not the card chrome. */
  chartRef: RefObject<HTMLDivElement | null>;
  isLoading: boolean;
  isError: boolean;
  showEmpty: boolean;
  onRetry: () => void;
  isSprintCtx: boolean;
  sprint: Parameters<typeof ChartEmpty>[0]['sprint'];
  iterationLabel: string;
  points: Parameters<typeof BurnChartCanvas>[0]['points'] | null;
  variant: BurnVariant;
  metric: BurnMetric;
  scopeChanges: ScopeChange[];
  today: string;
  /** sr-only prose alternative for the SVG (issue 2175). */
  chartSummary: string;
}

/**
 * The chart area's four mutually-exclusive states: loading skeleton, load
 * error with retry, empty state, or the rendered series plus its sr-only
 * text alternative.
 */
export function BurnChartBody({
  chartRef,
  isLoading,
  isError,
  showEmpty,
  onRetry,
  isSprintCtx,
  sprint,
  iterationLabel,
  points,
  variant,
  metric,
  scopeChanges,
  today,
  chartSummary,
}: BurnChartBodyProps) {
  const showChart = !isLoading && !isError && !showEmpty && points;
  return (
    <div ref={chartRef} className="px-4 py-4">
      {isLoading && <ChartSkeleton />}
      {isError && <ChartError onRetry={onRetry} />}
      {showEmpty && !isError && (
        <ChartEmpty isSprintCtx={isSprintCtx} sprint={sprint} iterationLabel={iterationLabel} />
      )}
      {showChart && (
        <>
          <p className="sr-only">{chartSummary}</p>
          <BurnChartCanvas
            points={points}
            variant={variant}
            metric={metric}
            scopeChanges={scopeChanges}
            today={today}
          />
        </>
      )}
    </div>
  );
}
