import { useState, useRef, useCallback, type KeyboardEvent, type MouseEvent } from 'react';
import type { GanttScaleData } from '@svar-ui/gantt-store/dist/types/types';
import type { MonteCarloResult } from '@/types';
import { MonteCarloHistogram } from './MonteCarloHistogram';

// Bar render order: P95 first (bottom), P80, P50 on top.
// This ensures the shorter, solid P50 bar is always fully visible.
interface BarSpec {
  key: keyof Pick<MonteCarloResult, 'p50' | 'p80' | 'p95'>;
  label: string;
  colorClass: string;
  /** Tailwind background-image class to simulate dashed/dotted via repeating-gradient */
  pattern: 'solid' | 'dashed' | 'dotted';
}

const BARS: BarSpec[] = [
  { key: 'p95', label: 'P95', colorClass: 'bg-semantic-critical', pattern: 'dotted' },
  { key: 'p80', label: 'P80', colorClass: 'bg-semantic-at-risk',  pattern: 'dashed' },
  { key: 'p50', label: 'P50', colorClass: 'bg-semantic-on-track', pattern: 'solid'  },
];

const BAR_H = 4;

interface ConfidenceBarProps {
  startLeft: number;
  endLeft: number;
  spec: BarSpec;
  isoDate: string;
  /** Stacking order within the 44px row — 0 = bottom, 2 = top */
  zIndex: number;
}

/**
 * Single horizontal confidence bar spanning from the timeline origin (project
 * start) to the percentile date end. A rotated diamond end-cap provides a
 * shape differentiator in addition to color and stroke pattern (WCAG 1.4.1).
 */
function ConfidenceBar({ startLeft, endLeft, spec, isoDate, zIndex }: ConfidenceBarProps) {
  const formatted = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(isoDate));

  const width = Math.max(0, endLeft - startLeft);

  // Vertical position: all bars share the same vertical centre in the 44px row
  // (top: 50% - 2px = 20px from top). Slight y-offset per bar so labels don't overlap.
  const topOffset = zIndex === 2 ? 14 : zIndex === 1 ? 19 : 24;

  // Dashed/dotted overlay: we render the bar as a solid div, then apply a
  // repeating-gradient mask for non-solid patterns using inline style.
  const patternStyle =
    spec.pattern === 'dashed'
      ? {
          backgroundImage:
            'repeating-linear-gradient(90deg, transparent 0, transparent 4px, rgba(255,255,255,0.6) 4px, rgba(255,255,255,0.6) 8px)',
        }
      : spec.pattern === 'dotted'
        ? {
            backgroundImage:
              'repeating-linear-gradient(90deg, transparent 0, transparent 2px, rgba(255,255,255,0.6) 2px, rgba(255,255,255,0.6) 5px)',
          }
        : {};

  return (
    <div
      className="absolute"
      style={{ left: startLeft, top: topOffset, width, height: BAR_H, zIndex }}
      role="presentation"
      aria-hidden="true"
    >
      {/* Bar fill */}
      <div
        className={`absolute inset-0 rounded-sm ${spec.colorClass}`}
        style={patternStyle}
      />

      {/* Diamond end-cap at the bar's right terminus */}
      <div
        className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rotate-45 border border-neutral-border ${spec.colorClass}`}
        style={{ left: width }}
      />

      {/* Date label above the end-cap */}
      <span
        className={`absolute -top-4 whitespace-nowrap text-[9px] font-medium ${spec.colorClass.replace('bg-', 'text-')}`}
        style={{ left: Math.max(0, width - 20) }}
      >
        {spec.label}: {formatted}
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
 * Timeline side of the Monte Carlo row. Renders three horizontal confidence
 * bars spanning from the project start date to P50/P80/P95 completion dates,
 * positioned using SVAR's scale geometry via useSvarScale().
 *
 * P95 renders first (bottom), P80 above, P50 on top so the solid green bar
 * is always fully visible. Diamond end-caps provide shape differentiation
 * (WCAG 1.4.1) in addition to color and stroke pattern.
 *
 * role="button" + aria-haspopup="dialog" + aria-expanded makes the row
 * keyboard-accessible for the histogram tooltip.
 */
export function MonteCarloTimeline({ result, scrollLeft, scales }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const openTooltip = useCallback((x: number, y: number) => {
    setTooltipPos({ x, y });
    setIsOpen(true);
  }, []);

  const closeTooltip = useCallback(() => {
    setTooltipPos(null);
    setIsOpen(false);
  }, []);

  const showAtCenter = useCallback(() => {
    const el = rowRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    openTooltip(rect.left + rect.width / 2, rect.top);
  }, [openTooltip]);

  const handleMouseEnter = useCallback(
    (e: MouseEvent<HTMLDivElement>) => openTooltip(e.clientX, e.clientY),
    [openTooltip],
  );
  const handleMouseMove = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (isOpen) setTooltipPos({ x: e.clientX, y: e.clientY });
    },
    [isOpen],
  );
  const handleMouseLeave = useCallback(closeTooltip, [closeTooltip]);
  const handleFocus = useCallback(showAtCenter, [showAtCenter]);
  const handleBlur = useCallback(closeTooltip, [closeTooltip]);
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (isOpen) { closeTooltip(); } else { showAtCenter(); }
      }
      if (e.key === 'Escape') closeTooltip();
    },
    [isOpen, closeTooltip, showAtCenter],
  );

  /** Convert an ISO date to a pixel left-offset from the timeline canvas origin. */
  function dateToLeft(isoDate: string): number | null {
    if (!scales) return null;
    const totalUnits = scales.diff(scales.end, scales.start);
    if (totalUnits <= 0) return null;
    const pxPerUnit = scales.width / totalUnits;
    const unitsFromStart = scales.diff(new Date(isoDate), scales.start);
    return unitsFromStart * pxPerUnit - scrollLeft;
  }

  // Bars start at the timeline canvas origin (project start ≈ scales.start)
  const originLeft = scales ? -scrollLeft : null;
  const p50Left = dateToLeft(result.p50);
  const p80Left = dateToLeft(result.p80);
  const p95Left = dateToLeft(result.p95);
  const barsReady =
    originLeft !== null && p50Left !== null && p80Left !== null && p95Left !== null;
  // Narrowed values, safe to use after barsReady guard
  const endLeftByBar = [p95Left ?? 0, p80Left ?? 0, p50Left ?? 0];

  return (
    <>
      <div
        ref={rowRef}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={`Monte Carlo: P50 ${result.p50}, P80 ${result.p80}, P95 ${result.p95}. Press Enter for distribution.`}
        className="flex-1 min-w-0 relative overflow-hidden border-t border-neutral-border bg-neutral-surface
          cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset
          focus-visible:ring-brand-primary"
        onMouseEnter={handleMouseEnter}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      >
        {barsReady && (
          <>
            {BARS.map((spec, i) => (
              <ConfidenceBar
                key={spec.key}
                startLeft={originLeft ?? 0}
                endLeft={endLeftByBar[i] ?? 0}
                spec={spec}
                isoDate={result[spec.key]}
                zIndex={i}
              />
            ))}
          </>
        )}

        {!barsReady && scales === null && (
          <div className="flex items-center h-full px-3">
            <span className="text-xs text-neutral-text-disabled">Loading…</span>
          </div>
        )}
      </div>

      {/* Histogram tooltip — fixed-position to escape overflow:hidden ancestors */}
      {isOpen && tooltipPos && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="Monte Carlo distribution histogram"
          className={`fixed z-50 w-60 p-3 rounded border border-neutral-border bg-neutral-surface pointer-events-none ${
            prefersReducedMotion ? '' : 'motion-safe:transition-opacity motion-safe:duration-150'
          }`}
          style={{
            left: Math.min(tooltipPos.x - 120, window.innerWidth - 256),
            top: tooltipPos.y - 168,
          }}
        >
          <p className="text-xs text-neutral-text-secondary mb-1.5">
            Distribution of project end dates
          </p>
          <MonteCarloHistogram result={result} />
          <div className="mt-2 flex items-center gap-4 text-[10px] text-neutral-text-secondary">
            <span>
              <span className="inline-block w-2.5 h-1 bg-semantic-on-track mr-1 rounded-sm" aria-hidden="true" />
              P50 {result.p50}
            </span>
            <span>
              <span className="inline-block w-2.5 h-1 bg-semantic-at-risk mr-1 rounded-sm" aria-hidden="true" />
              P80 {result.p80}
            </span>
            <span>
              <span className="inline-block w-2.5 h-1 bg-semantic-critical mr-1 rounded-sm" aria-hidden="true" />
              P95 {result.p95}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
