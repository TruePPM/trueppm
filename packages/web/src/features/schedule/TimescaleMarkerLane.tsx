import { useEffect, useRef, type RefObject } from 'react';
import { useChartHeaderHeight } from '@/hooks/useChartHeaderHeight';
import { todayISO } from '@/features/resource/resourceUtils';
import { fmtUtcShort, fmtUtcLong } from '@/lib/formatUtcDate';
import type { MonteCarloResult } from '@/types';
import type { GanttScaleData } from './engine';
import { dateToLeft } from './engine';
import { MARKER_LANE_HEIGHT, markerLaneTop } from './scheduleConstants';
import { layoutMarkerLane, type LaneMarkerInput, type LaneMarkerKind } from './markerLaneLayout';

interface Props {
  result: MonteCarloResult | null;
  scaleData: GanttScaleData | null;
  canvasScrollRef: RefObject<HTMLDivElement | null>;
}

const STYLE: Record<LaneMarkerKind, { tick: string; chip: string }> = {
  today: {
    tick: 'bg-semantic-on-track',
    chip: 'text-semantic-on-track border-semantic-on-track/40',
  },
  p80: {
    tick: 'bg-semantic-at-risk',
    chip: 'text-semantic-at-risk border-semantic-at-risk/40',
  },
  target: {
    tick: 'bg-neutral-text-secondary',
    chip: 'text-neutral-text-secondary border-neutral-border',
  },
};

interface Spec {
  kind: LaneMarkerKind;
  iso: string;
  fullText: string;
  shortText: string;
  preferredSide: LaneMarkerInput['preferredSide'];
  title: string;
}

/**
 * The 18px lane under the timescale tiers that carries the Today, P80 and Target
 * labels (#4068). The P80 label sits left of its line and Target right, so two
 * dates a few days apart open away from each other; anything that still collides
 * falls back to a short label, then to a bare tick (`layoutMarkerLane`).
 *
 * Percentiles render once (ADR-0144, web rule 189): the P80 chip lives here and
 * `MonteCarloGanttMarkers` draws only the P80 line. Positions are written through
 * DOM refs on scroll so panning never re-renders (rule 57).
 */
export function TimescaleMarkerLane({ result, scaleData, canvasScrollRef }: Props) {
  // Subscribed so the lane's top follows the cadence rail appearing (rule 315c).
  useChartHeaderHeight();
  const top = markerLaneTop();
  const today = todayISO();
  const commitment = result?.commitmentDate ?? null;

  const specs: Spec[] = [
    {
      kind: 'today',
      iso: today,
      fullText: 'Today',
      shortText: 'Today',
      preferredSide: 'auto',
      title: `Today: ${fmtUtcLong(today)}`,
    },
  ];
  if (result) {
    specs.push({
      kind: 'p80',
      iso: result.p80,
      fullText: `P80: ${fmtUtcShort(result.p80)}`,
      shortText: 'P80',
      preferredSide: 'left',
      title: `P80: ${fmtUtcLong(result.p80)}`,
    });
  }
  if (commitment) {
    specs.push({
      kind: 'target',
      iso: commitment,
      fullText: `Target: ${fmtUtcShort(commitment)}`,
      shortText: 'Target',
      preferredSide: 'right',
      title: `Target: ${fmtUtcLong(commitment)}`,
    });
  }
  const specKey = specs.map((s) => `${s.kind}:${s.iso}`).join('|');

  const tickRefs = useRef(new Map<LaneMarkerKind, HTMLDivElement>());
  const chipRefs = useRef(new Map<LaneMarkerKind, HTMLSpanElement>());

  useEffect(() => {
    const container = canvasScrollRef.current;
    if (!container || !scaleData) return;

    const update = () => {
      const scrollLeft = container.scrollLeft;
      const viewportWidth = container.clientWidth;
      const inputs: LaneMarkerInput[] = [];
      for (const s of specs) {
        try {
          inputs.push({
            kind: s.kind,
            x: dateToLeft(s.iso, scaleData) - scrollLeft,
            fullText: s.fullText,
            shortText: s.shortText,
            preferredSide: s.preferredSide,
          });
        } catch {
          // An unparseable date draws nothing rather than a chip at NaN.
        }
      }
      for (const p of layoutMarkerLane(inputs, viewportWidth)) {
        const tick = tickRefs.current.get(p.kind);
        const chip = chipRefs.current.get(p.kind);
        const onScreen = p.x >= -1 && p.x <= viewportWidth + 1;
        if (tick) {
          tick.style.left = `${p.x}px`;
          tick.style.visibility = onScreen ? 'visible' : 'hidden';
        }
        if (chip) {
          chip.textContent = p.text;
          chip.style.left = `${p.left}px`;
          chip.style.visibility = onScreen && p.labelShown ? 'visible' : 'hidden';
          chip.dataset.side = p.side;
        }
      }
    };

    update();
    container.addEventListener('scroll', update, { passive: true });
    return () => container.removeEventListener('scroll', update);
    // `specs` is derived from `specKey`; listing it would re-subscribe every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, scaleData, canvasScrollRef]);

  if (!scaleData) return null;

  return (
    <div
      data-testid="marker-lane"
      aria-hidden="true"
      className="pointer-events-none absolute left-0 right-0 overflow-hidden"
      style={{ top, height: MARKER_LANE_HEIGHT }}
    >
      {specs.map((s) => (
        <div key={s.kind} title={s.title}>
          <div
            ref={(el) => {
              if (el) tickRefs.current.set(s.kind, el);
              else tickRefs.current.delete(s.kind);
            }}
            data-testid={`marker-lane-tick-${s.kind}`}
            className={`absolute top-0 bottom-0 w-px ${STYLE[s.kind].tick}`}
            style={{ left: 0 }}
          />
          <span
            ref={(el) => {
              if (el) chipRefs.current.set(s.kind, el);
              else chipRefs.current.delete(s.kind);
            }}
            data-testid={`marker-lane-${s.kind}`}
            className={`absolute top-px whitespace-nowrap text-xs leading-[14px] font-medium border rounded-chip px-1.5 bg-neutral-surface ${STYLE[s.kind].chip}`}
            style={{ left: 0 }}
          >
            {s.fullText}
          </span>
        </div>
      ))}
    </div>
  );
}
