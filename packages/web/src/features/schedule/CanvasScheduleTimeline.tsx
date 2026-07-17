/**
 * Three-layer canvas Gantt timeline component.
 *
 * Renders three stacked <canvas> elements (bg / bars / interaction) plus a
 * transparent ScheduleAriaOverlay for accessibility (rule 67).
 *
 * The host div is `position: relative; width: 100%; height: 100%` so canvases
 * fill the available space. The aria overlay is z-index 3 (pointer-events: none).
 *
 * Design rules enforced:
 * - Rule 59: three-layer canvas stack, one responsibility each
 * - Rule 62: DPR scaling managed by GanttEngineImpl via useGanttEngine
 * - Rule 66: touch-action: none on all canvas elements
 * - Rule 67: ScheduleAriaOverlay mandatory; canvas elements aria-hidden
 */

import { useRef, useEffect, useMemo, type CSSProperties, type RefObject } from 'react';
import type { Task, TaskLink } from '@/types';
import type { ChartRenderOptions, GanttEngine, ZoomLevel } from './engine';
import { useGanttEngine } from '@/hooks/useGanttEngine';
import { useIsDark } from '@/hooks/useIsDark';
import { useFiscalYearStartMonth } from '@/hooks/useFiscalYearStartMonth';
import { useScheduleStore } from '@/stores/scheduleStore';
import { ScheduleAriaOverlay } from './ScheduleAriaOverlay';

interface CanvasScheduleTimelineProps {
  tasks: Task[];
  links: TaskLink[];
  zoomLevel: ZoomLevel;
  /** Chart menu toggles — on-bar name placement + progress-pill visibility (#2097).
   *  Defaults to everything-visible for hosts without a Display menu (e.g. the
   *  read-only program schedule view). */
  chartOptions?: ChartRenderOptions;
  containerRef: RefObject<HTMLDivElement | null>;
  onEngineReady: (engine: GanttEngine) => void;
}

const DEFAULT_CHART_OPTIONS: ChartRenderOptions = {
  taskNamePlacement: 'next',
  showProgressPills: true,
  showNameGutter: false,
};

export function CanvasScheduleTimeline({
  tasks,
  links,
  zoomLevel,
  chartOptions = DEFAULT_CHART_OPTIONS,
  containerRef,
  onEngineReady,
}: CanvasScheduleTimelineProps) {
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const barsCanvasRef = useRef<HTMLCanvasElement>(null);
  const ixCanvasRef = useRef<HTMLCanvasElement>(null);

  const isDark = useIsDark();
  const fiscalStartMonth = useFiscalYearStartMonth();
  const quarterMode = useScheduleStore((s) => s.quarterMode);
  // Continuous zoom (#351). pxPerDay is the source of truth; the engine derives
  // the tier. setPxPerDay closes the loop for imperative zoom (wheel / pinch /
  // toolbar): the engine's scales-change pushes the resulting pxPerDay back into
  // the store so the toolbar readout and +/- disabled states stay in sync.
  const pxPerDay = useScheduleStore((s) => s.pxPerDay);
  const setPxPerDay = useScheduleStore((s) => s.setPxPerDay);
  // Memoized so the engine's setFiscalConfig effect only fires on real changes.
  const fiscalConfig = useMemo(
    () => ({ startMonth: fiscalStartMonth, mode: quarterMode }),
    [fiscalStartMonth, quarterMode],
  );

  const engine = useGanttEngine(
    containerRef,
    bgCanvasRef,
    barsCanvasRef,
    ixCanvasRef,
    zoomLevel,
    isDark,
    fiscalConfig,
    pxPerDay,
  );

  // Push the engine's continuous zoom back into the store after imperative
  // zoom (Ctrl+wheel, pinch, ⌘0 fit). The engine fires scales-change with the
  // new scale; read its pxPerDay and sync the store so the controlled effect in
  // useGanttEngine stays a no-op (setPxPerDay there early-returns on a match)
  // and the toolbar reflects the live tier (#351).
  useEffect(() => {
    if (!engine) return;
    return engine.on('scales-change', () => {
      const next = engine.pxPerDay;
      if (next !== null) setPxPerDay(next);
    });
  }, [engine, setPxPerDay]);

  // Feed tasks to engine (rule 55: setTasks/setLinks are not subscriptions)
  useEffect(() => {
    if (!engine) return;
    engine.setTasks(tasks);
  }, [engine, tasks]);

  useEffect(() => {
    if (!engine) return;
    engine.setLinks(links);
  }, [engine, links]);

  // Push Chart menu toggles (name placement / progress pills) to the engine (#2097).
  useEffect(() => {
    if (!engine) return;
    engine.setChartOptions(chartOptions);
  }, [engine, chartOptions]);

  // Notify parent when engine becomes available (rule 55: no on() here)
  useEffect(() => {
    if (!engine) return;
    onEngineReady(engine);
  }, [engine, onEngineReady]);

  const canvasStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    touchAction: 'none',
    pointerEvents: 'none', // bg and bars layers are display-only
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Layer 0: row bands, grid lines, today line */}
      <canvas
        ref={bgCanvasRef}
        data-layer="bg"
        aria-hidden="true"
        style={{ ...canvasStyle, zIndex: 0 }}
      />
      {/* Layer 1: task bars, dependency arrows */}
      <canvas
        ref={barsCanvasRef}
        data-layer="bars"
        aria-hidden="true"
        style={{ ...canvasStyle, zIndex: 1 }}
      />
      {/* Layer 2: drag shadow, resize indicator — must receive pointer events */}
      <canvas
        ref={ixCanvasRef}
        data-layer="interaction"
        aria-hidden="true"
        style={{ ...canvasStyle, zIndex: 2, pointerEvents: 'auto' }}
      />
      {/* Layer 3: accessible ARIA grid overlay (pointer-events: none) */}
      <ScheduleAriaOverlay
        engine={engine}
        tasks={tasks}
        links={links}
        containerRef={containerRef}
      />
    </div>
  );
}
