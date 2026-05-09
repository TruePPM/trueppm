import { useEffect, useRef, type RefObject } from 'react';
import type { MonteCarloResult } from '@/types';
import type { GanttScaleData } from './engine';
import { dateToLeft } from './engine';
import { HEADER_HEIGHT } from './scheduleConstants';

interface Props {
  result: MonteCarloResult | null;
  scaleData: GanttScaleData | null;
  /** The scrollable canvas container — used to subscribe to scroll events. */
  canvasScrollRef: RefObject<HTMLDivElement | null>;
}

const MARKERS = [
  {
    key: 'p50' as const,
    label: 'P50',
    lineClass: 'bg-semantic-on-track/40',
    chipClass: 'text-semantic-on-track border-semantic-on-track/40',
  },
  {
    key: 'p80' as const,
    label: 'P80',
    lineClass: 'bg-semantic-at-risk/40',
    chipClass: 'text-semantic-at-risk border-semantic-at-risk/40',
  },
  {
    key: 'p95' as const,
    label: 'P95',
    lineClass: 'bg-semantic-critical/40',
    chipClass: 'text-semantic-critical border-semantic-critical/40',
  },
] as const;

function fmtShort(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
    new Date(iso),
  );
}

function fmtLong(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));
}

/**
 * HTML overlay rendering P50/P80/P95 vertical marker lines on the Gantt canvas.
 *
 * Renders inside the sticky canvas viewport div as absolute-positioned children.
 * Left = dateToLeft(date, scaleData) − scrollLeft.
 * Updated via DOM ref writes on every scroll tick — no React re-render per scroll.
 *
 * Follows the MilestonePulseOverlay positioning pattern (rule 57): canvas-origin
 * coordinates from dateToLeft(), minus scrollLeft for viewport-relative placement.
 */
export function MonteCarloGanttMarkers({ result, scaleData, canvasScrollRef }: Props) {
  const markerRefs = useRef<(HTMLDivElement | null)[]>([null, null, null]);

  useEffect(() => {
    if (!result || !scaleData) return;
    const container = canvasScrollRef.current;
    if (!container) return;

    const updatePositions = () => {
      const scrollLeft = container.scrollLeft;
      const viewportWidth = container.clientWidth;
      MARKERS.forEach(({ key }, i) => {
        const el = markerRefs.current[i];
        if (!el) return;
        try {
          const x = dateToLeft(result[key], scaleData) - scrollLeft;
          el.style.left = `${x}px`;
          // Hide markers far outside the viewport to avoid stale label chips
          el.style.visibility = x < -120 || x > viewportWidth + 4 ? 'hidden' : 'visible';
        } catch {
          el.style.visibility = 'hidden';
        }
      });
    };

    updatePositions();
    container.addEventListener('scroll', updatePositions, { passive: true });
    return () => container.removeEventListener('scroll', updatePositions);
  }, [result, scaleData, canvasScrollRef]);

  if (!result || !scaleData) return null;

  return (
    <>
      {MARKERS.map(({ key, label, lineClass, chipClass }, i) => {
        const isoDate = result[key];
        return (
          <div
            key={key}
            ref={(el) => {
              markerRefs.current[i] = el;
            }}
            data-testid={`mc-marker-${key}`}
            aria-hidden="true"
            style={{ top: HEADER_HEIGHT, bottom: 0, position: 'absolute', left: 0, width: 1 }}
            className={`pointer-events-none ${lineClass}`}
            title={`${label}: ${fmtLong(isoDate)}`}
          >
            <span
              className={`absolute top-1 left-1 whitespace-nowrap text-xs font-medium border rounded px-1.5 py-px bg-neutral-surface ${chipClass}`}
            >
              {label}: {fmtShort(isoDate)}
            </span>
          </div>
        );
      })}
    </>
  );
}
