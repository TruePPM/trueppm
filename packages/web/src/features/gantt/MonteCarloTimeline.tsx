import { useState, useRef, useCallback, type KeyboardEvent, type MouseEvent } from 'react';
import type { GanttScaleData } from '@svar-ui/gantt-store/dist/types/types';
import type { MonteCarloResult } from '@/types';
import { MonteCarloHistogram } from './MonteCarloHistogram';

interface BarConfig {
  date: string;
  label: string;
  colorClass: string;
}

const BARS: BarConfig[] = [
  { date: 'p50', label: 'P50', colorClass: 'bg-semantic-on-track' },
  { date: 'p80', label: 'P80', colorClass: 'bg-semantic-at-risk' },
  { date: 'p95', label: 'P95', colorClass: 'bg-semantic-critical' },
];

interface ConfidenceLineProps {
  left: number;
  config: BarConfig;
  isoDate: string;
}

function ConfidenceLine({ left, config, isoDate }: ConfidenceLineProps) {
  const formatted = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(isoDate));

  const borderStyle =
    config.date === 'p80'
      ? 'border-dashed'
      : config.date === 'p95'
        ? 'border-dotted'
        : 'border-solid';

  return (
    <div
      className={`absolute top-2 bottom-2 w-0 border-l-2 ${borderStyle} ${config.colorClass.replace('bg-', 'border-')}`}
      style={{ left }}
      role="presentation"
      aria-hidden="true"
    >
      {/* Date label above the line */}
      <span
        className={`absolute -top-5 left-1 text-[10px] font-medium whitespace-nowrap ${config.colorClass.replace('bg-', 'text-')}`}
      >
        {config.label}: {formatted}
      </span>
    </div>
  );
}

interface Props {
  result: MonteCarloResult;
  scrollLeft: number;
  scales: GanttScaleData | null;
}

/**
 * Timeline side of the Monte Carlo row. Renders three vertical confidence
 * lines at P50/P80/P95 dates, positioned using SVAR's scale geometry.
 *
 * Horizontally scrolls in sync with the SVAR timeline via the scrollLeft
 * and scales values derived from useSvarScale().
 *
 * The element uses role="button" so keyboard users can focus it and reveal
 * the histogram tooltip via Enter or Space.
 */
export function MonteCarloTimeline({ result, scrollLeft, scales }: Props) {
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const showTooltipAtCenter = useCallback(() => {
    const el = rowRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top });
  }, []);

  const handleMouseEnter = useCallback((e: MouseEvent<HTMLDivElement>) => {
    setTooltipPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent<HTMLDivElement>) => {
    setTooltipPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setTooltipPos(null);
  }, []);

  const handleFocus = useCallback(showTooltipAtCenter, [showTooltipAtCenter]);

  const handleBlur = useCallback(() => setTooltipPos(null), []);

  function dateToLeft(isoDate: string): number | null {
    if (!scales) return null;
    const date = new Date(isoDate);
    const totalUnits = scales.diff(scales.end, scales.start);
    if (totalUnits <= 0) return null;
    const pxPerUnit = scales.width / totalUnits;
    const unitsFromStart = scales.diff(date, scales.start);
    return unitsFromStart * pxPerUnit - scrollLeft;
  }

  const p50Left = dateToLeft(result.p50);
  const p80Left = dateToLeft(result.p80);
  const p95Left = dateToLeft(result.p95);

  const barsReady = p50Left !== null && p80Left !== null && p95Left !== null;

  return (
    <>
      {/* role="button" makes tabIndex valid and enables keyboard focus for a11y */}
      <div
        ref={rowRef}
        role="button"
        tabIndex={0}
        className="flex-1 min-w-0 relative overflow-hidden border-t border-neutral-border bg-neutral-surface
          cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset
          focus-visible:ring-brand-primary"
        aria-label={`Monte Carlo: P50 ${result.p50}, P80 ${result.p80}, P95 ${result.p95}. Press Enter for distribution.`}
        onMouseEnter={handleMouseEnter}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={useCallback(
          (e: KeyboardEvent<HTMLDivElement>) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              showTooltipAtCenter();
            }
            if (e.key === 'Escape') setTooltipPos(null);
          },
          [showTooltipAtCenter],
        )}
      >
        {barsReady && (
          <>
            <ConfidenceLine left={p50Left} config={BARS[0]} isoDate={result.p50} />
            <ConfidenceLine left={p80Left} config={BARS[1]} isoDate={result.p80} />
            <ConfidenceLine left={p95Left} config={BARS[2]} isoDate={result.p95} />
          </>
        )}

        {!barsReady && scales === null && (
          <div className="flex items-center h-full px-3">
            <span className="text-xs text-neutral-text-disabled">Loading…</span>
          </div>
        )}
      </div>

      {/* Histogram tooltip — fixed-position to escape overflow:hidden ancestors */}
      {tooltipPos && (
        <div
          role="tooltip"
          className={`fixed z-50 p-3 rounded border border-neutral-border bg-neutral-surface pointer-events-none ${
            prefersReducedMotion ? '' : 'animate-fade-in'
          }`}
          style={{
            left: Math.min(tooltipPos.x + 8, window.innerWidth - 260),
            top: tooltipPos.y - 140,
          }}
        >
          <p className="text-xs font-medium text-neutral-text-primary mb-2">
            Completion probability
          </p>
          <MonteCarloHistogram result={result} />
          <dl className="mt-2 grid grid-cols-3 gap-x-3 text-[10px]">
            <div>
              <dt className="text-semantic-on-track font-medium">P50</dt>
              <dd className="text-neutral-text-secondary">{result.p50}</dd>
            </div>
            <div>
              <dt className="text-semantic-at-risk font-medium">P80</dt>
              <dd className="text-neutral-text-secondary">{result.p80}</dd>
            </div>
            <div>
              <dt className="text-semantic-critical font-medium">P95</dt>
              <dd className="text-neutral-text-secondary">{result.p95}</dd>
            </div>
          </dl>
        </div>
      )}
    </>
  );
}
