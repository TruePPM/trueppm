/**
 * Three-layer canvas Gantt timeline component.
 *
 * Renders three stacked <canvas> elements (bg / bars / interaction) plus a
 * transparent GanttAriaOverlay for accessibility (rule 67).
 *
 * The host div is `position: relative; width: 100%; height: 100%` so canvases
 * fill the available space. The aria overlay is z-index 3 (pointer-events: none).
 *
 * Design rules enforced:
 * - Rule 59: three-layer canvas stack, one responsibility each
 * - Rule 62: DPR scaling managed by GanttEngineImpl via useGanttEngine
 * - Rule 66: touch-action: none on all canvas elements
 * - Rule 67: GanttAriaOverlay mandatory; canvas elements aria-hidden
 */

import { useRef, useEffect, type CSSProperties, type RefObject } from 'react';
import type { Task, TaskLink } from '@/types';
import type { GanttEngine, ZoomLevel } from './engine';
import { useGanttEngine } from '@/hooks/useGanttEngine';
import { GanttAriaOverlay } from './GanttAriaOverlay';

interface CanvasGanttTimelineProps {
  tasks: Task[];
  links: TaskLink[];
  zoomLevel: ZoomLevel;
  containerRef: RefObject<HTMLDivElement | null>;
  onEngineReady: (engine: GanttEngine) => void;
}

export function CanvasGanttTimeline({
  tasks,
  links,
  zoomLevel,
  containerRef,
  onEngineReady,
}: CanvasGanttTimelineProps) {
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const barsCanvasRef = useRef<HTMLCanvasElement>(null);
  const ixCanvasRef = useRef<HTMLCanvasElement>(null);

  const engine = useGanttEngine(
    containerRef,
    bgCanvasRef,
    barsCanvasRef,
    ixCanvasRef,
    zoomLevel,
  );

  // Feed tasks to engine (rule 55: setTasks/setLinks are not subscriptions)
  useEffect(() => {
    if (!engine) return;
    engine.setTasks(tasks);
  }, [engine, tasks]);

  useEffect(() => {
    if (!engine) return;
    engine.setLinks(links);
  }, [engine, links]);

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
        aria-hidden="true"
        style={{ ...canvasStyle, zIndex: 0 }}
      />
      {/* Layer 1: task bars, dependency arrows */}
      <canvas
        ref={barsCanvasRef}
        aria-hidden="true"
        style={{ ...canvasStyle, zIndex: 1 }}
      />
      {/* Layer 2: drag shadow, resize indicator — must receive pointer events */}
      <canvas
        ref={ixCanvasRef}
        aria-hidden="true"
        style={{ ...canvasStyle, zIndex: 2, pointerEvents: 'auto' }}
      />
      {/* Layer 3: accessible ARIA grid overlay (pointer-events: none) */}
      <GanttAriaOverlay engine={engine} tasks={tasks} containerRef={containerRef} />
    </div>
  );
}
