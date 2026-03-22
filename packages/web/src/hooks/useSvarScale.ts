import { useState, useEffect } from 'react';
import type { IApi } from '@svar-ui/gantt-store';
import type { GanttScaleData } from '@svar-ui/gantt-store/dist/types/types';

export interface SvarScale {
  /** Current horizontal scroll offset of the SVAR timeline canvas (px) */
  scrollLeft: number;
  /**
   * SVAR internal scale data: total canvas width, start/end dates, and a
   * `diff(a, b)` function for date distance in the current length unit.
   * Null until SVAR has rendered its first frame.
   */
  scales: GanttScaleData | null;
}

/**
 * Bridges SVAR Gantt's internal reactive state (scroll position + scale) into
 * React state so downstream components can position date-aligned overlays.
 *
 * Subscribes to SVAR's `scroll-chart` and `zoom-scale` / `expand-scale` events
 * to stay in sync with user interaction. Reads the initial state once the API
 * becomes available (ganttApi transitions from null → IApi instance).
 *
 * Usage:
 *   const { scrollLeft, scales } = useSvarScale(ganttApi);
 *   // Convert a date to a left-offset px value:
 *   if (scales) {
 *     const totalUnits = scales.diff(scales.end, scales.start);
 *     const pxPerUnit = scales.width / totalUnits;
 *     const left = scales.diff(targetDate, scales.start) * pxPerUnit - scrollLeft;
 *   }
 */
export function useSvarScale(ganttApi: IApi | null): SvarScale {
  const [scrollLeft, setScrollLeft] = useState(0);
  const [scales, setScales] = useState<GanttScaleData | null>(null);

  useEffect(() => {
    if (!ganttApi) return;

    // Seed from current state immediately
    const state = ganttApi.getState();
    setScrollLeft(state.scrollLeft ?? 0);
    setScales(state._scales ?? null);

    // Horizontal scroll — SVAR fires with { left?, top? }
    ganttApi.on('scroll-chart', ({ left }: { left?: number; top?: number }) => {
      if (left !== undefined) setScrollLeft(left);
    });

    // Zoom changes update the scale geometry
    const refreshScales = () => {
      const s = ganttApi.getState();
      setScales(s._scales ?? null);
      setScrollLeft(s.scrollLeft ?? 0);
    };
    ganttApi.on('zoom-scale', refreshScales);
    ganttApi.on('expand-scale', refreshScales);
  }, [ganttApi]);

  return { scrollLeft, scales };
}
