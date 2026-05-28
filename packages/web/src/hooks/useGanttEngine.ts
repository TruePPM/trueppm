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
import type { FiscalConfig, GanttEngine, ZoomLevel } from '@/features/schedule/engine';
import { CALENDAR_QUARTERS, GanttEngineImpl } from '@/features/schedule/engine';

export function useGanttEngine(
  containerRef: RefObject<HTMLDivElement | null>,
  bgCanvasRef: RefObject<HTMLCanvasElement | null>,
  barsCanvasRef: RefObject<HTMLCanvasElement | null>,
  ixCanvasRef: RefObject<HTMLCanvasElement | null>,
  zoomLevel: ZoomLevel,
  isDark = false,
  fiscalConfig: FiscalConfig = CALENDAR_QUARTERS,
  pxPerDay: number | null = null,
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

  // Respond to continuous zoom changes (#351). When the store provides a
  // `pxPerDay`, it is the source of truth; the engine's `setPxPerDay` derives
  // the tier internally. We fall back to the discrete `setZoom(zoomLevel)` only
  // when no pxPerDay is supplied (e.g. tests that pass the legacy signature).
  // Wheel/pinch zoom drive the engine imperatively, then push the resulting
  // pxPerDay back into the store; this effect re-runs and is a no-op because
  // the value already matches (setPxPerDay early-returns on an unchanged value).
  useEffect(() => {
    if (!engine) return;
    if (pxPerDay !== null) {
      engine.setPxPerDay(pxPerDay);
    } else {
      engine.setZoom(zoomLevel);
    }
  }, [engine, zoomLevel, pxPerDay]);

  // Respond to dark mode changes
  useEffect(() => {
    if (!engine) return;
    engine.setDark(isDark);
  }, [engine, isDark]);

  // Respond to fiscal quarter-mode changes (#755). The caller memoizes
  // `fiscalConfig` so this only fires when startMonth or mode actually changes.
  useEffect(() => {
    if (!engine) return;
    engine.setFiscalConfig(fiscalConfig);
  }, [engine, fiscalConfig]);

  return engine;
}
