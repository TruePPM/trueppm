/**
 * React hook that mounts a GanttEngineImpl once and tears it down on unmount.
 *
 * The engine is created with an empty dep array (mount once). A separate
 * useEffect responds to zoom level changes and calls engine.setZoom().
 *
 * Design rules enforced:
 * - Rule 54: GanttEngine is the sole integration boundary
 * - Rule 55: engine.on() always paired with unsubscribe in useEffect cleanup
 * - Rule 62: DPR scaling handled inside GanttEngineImpl
 */

import { useState, useEffect, type RefObject } from 'react';
import type { GanttEngine, ZoomLevel } from '@/features/gantt/engine';
import { GanttEngineImpl } from '@/features/gantt/engine';

export function useGanttEngine(
  containerRef: RefObject<HTMLDivElement | null>,
  bgCanvasRef: RefObject<HTMLCanvasElement | null>,
  barsCanvasRef: RefObject<HTMLCanvasElement | null>,
  ixCanvasRef: RefObject<HTMLCanvasElement | null>,
  zoomLevel: ZoomLevel,
  isDark = false,
): GanttEngine | null {
  const [engine, setEngine] = useState<GanttEngine | null>(null);

  // Mount once — create engine, destroy on unmount
  useEffect(() => {
    const container = containerRef.current;
    const bgCanvas = bgCanvasRef.current;
    const barsCanvas = barsCanvasRef.current;
    const ixCanvas = ixCanvasRef.current;

    if (!container || !bgCanvas || !barsCanvas || !ixCanvas) return;

    // Guard: canvas must support 2D context
    if (
      !bgCanvas.getContext('2d') ||
      !barsCanvas.getContext('2d') ||
      !ixCanvas.getContext('2d')
    ) {
      return;
    }

    const impl = new GanttEngineImpl({
      container,
      bgCanvas,
      barsCanvas,
      ixCanvas,
      initialZoom: zoomLevel,
      isDark,
    });

    setEngine(impl);

    return () => {
      impl.destroy();
      setEngine(null);
    };
    // Mount once — intentionally empty deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Respond to zoom changes
  useEffect(() => {
    if (!engine) return;
    engine.setZoom(zoomLevel);
  }, [engine, zoomLevel]);

  // Respond to dark mode changes
  useEffect(() => {
    if (!engine) return;
    engine.setDark(isDark);
  }, [engine, isDark]);

  return engine;
}
