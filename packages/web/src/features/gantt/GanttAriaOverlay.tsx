/**
 * Transparent DOM overlay providing WCAG 2.1 grid structure over the canvas.
 *
 * The canvas elements are aria-hidden. This overlay provides the accessible
 * tree: role="grid" > role="row" > role="gridcell" with roving tabindex.
 *
 * Virtualised to match the canvas render window (same overscan = 5 rows).
 * Tracks scrollTop from engine.on('scroll') and updates focus ring position.
 *
 * Design rules enforced:
 * - Rule 67: GanttAriaOverlay is mandatory; canvas aria-hidden="true"
 * - Rule 68: ARIA grid uses roving tabindex; keyboard nav in overlay
 * - Rule 69: buildTaskAriaLabel canonical format
 */

import { useState, useEffect, useCallback, useRef, type KeyboardEvent, type RefObject } from 'react';
import type { Task } from '@/types';
import type { GanttEngine } from './engine';
import { dateToLeft } from './engine';
import { ROW_HEIGHT, BAR_TOP_OFFSET, BAR_HEIGHT } from './engine/GanttHitIndex';
import { HEADER_HEIGHT } from './ganttConstants';

const OVERSCAN_ROWS = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAriaDate(isoDate: string): string {
  if (!isoDate) return 'unscheduled';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(isoDate + 'T00:00:00Z'));
}

/**
 * Canonical aria-label format (rule 69):
 * "{name}, {durationDays} days, starts {start}, finishes {finish}{cp}"
 */
export function buildTaskAriaLabel(task: Task): string {
  const cp = task.isCritical ? ', on the critical path' : '';
  if (!task.start || !task.finish) {
    return `${task.name}, ${task.duration} days, unscheduled`;
  }
  return `${task.name}, ${task.duration} days, starts ${formatAriaDate(task.start)}, finishes ${formatAriaDate(task.finish)}${cp}`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface GanttAriaOverlayProps {
  engine: GanttEngine | null;
  tasks: Task[];
  containerRef: RefObject<HTMLDivElement | null>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GanttAriaOverlay({ engine, tasks, containerRef }: GanttAriaOverlayProps) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Track scroll from engine events (rule 55: always unsubscribe)
  useEffect(() => {
    if (!engine) return;
    const off = engine.on('scroll', ({ scrollLeft: _sl }) => {
      // scrollTop from container directly (engine only emits scrollLeft)
      if (containerRef.current) {
        setScrollTop(containerRef.current.scrollTop);
      }
    });
    return off;
  }, [engine, containerRef]);

  // Seed scrollTop and viewportHeight from container
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const update = () => {
      setScrollTop(container.scrollTop);
      setViewportHeight(container.clientHeight);
    };
    update();

    const ro = new ResizeObserver(update);
    ro.observe(container);
    container.addEventListener('scroll', update, { passive: true });
    return () => {
      ro.disconnect();
      container.removeEventListener('scroll', update);
    };
  }, [containerRef]);

  // Virtualised row range — viewportHeight is reduced by fixed header band
  const overscan = OVERSCAN_ROWS * ROW_HEIGHT;
  const minY = scrollTop - overscan;
  const maxY = scrollTop + viewportHeight - HEADER_HEIGHT + overscan;
  const firstRow = Math.max(0, Math.floor(minY / ROW_HEIGHT));
  const lastRow = Math.min(tasks.length - 1, Math.ceil(maxY / ROW_HEIGHT));

  // Roving tabindex keyboard handler (rule 68)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, taskId: string) => {
      const idx = tasks.findIndex((t) => t.id === taskId);
      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          const next = tasks[idx + 1];
          if (next) {
            setFocusedTaskId(next.id);
            // Scroll into view if needed
            if (engine) engine.scrollToDate(next.start);
          }
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const prev = tasks[idx - 1];
          if (prev) {
            setFocusedTaskId(prev.id);
            if (engine) engine.scrollToDate(prev.start);
          }
          break;
        }
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (engine) engine.selectTask(taskId);
          break;
      }
    },
    [tasks, engine],
  );

  const scales = engine?.scales ?? null;

  return (
    <div
      ref={gridRef}
      role="grid"
      aria-rowcount={tasks.length}
      aria-label="Gantt chart"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      {tasks.slice(firstRow, lastRow + 1).map((task, sliceIdx) => {
        const rowIndex = firstRow + sliceIdx;
        const rowTop = rowIndex * ROW_HEIGHT + HEADER_HEIGHT - scrollTop;
        const isFocused = task.id === focusedTaskId;

        // Bar geometry for focus ring positioning (rule 68)
        let barLeft = 0;
        let barWidth = 0;
        if (scales) {
          barLeft = dateToLeft(task.start, scales) - (engine?.scrollLeft ?? 0);
          const barRight = dateToLeft(task.finish, scales) - (engine?.scrollLeft ?? 0);
          barWidth = Math.max(2, barRight - barLeft);
        }

        return (
          <div
            key={task.id}
            role="row"
            aria-rowindex={rowIndex + 1}
            style={{
              position: 'absolute',
              top: rowTop,
              left: 0,
              right: 0,
              height: ROW_HEIGHT,
              pointerEvents: isFocused ? 'auto' : 'none',
            }}
          >
            <div
              role="gridcell"
              tabIndex={isFocused ? 0 : -1}
              aria-label={buildTaskAriaLabel(task)}
              aria-selected={engine?.selectedTaskIds.has(task.id)}
              className="focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-1 focus-visible:ring-offset-[#0F1117] rounded-sm outline-none"
              style={{
                position: 'absolute',
                left: barLeft,
                top: BAR_TOP_OFFSET,
                width: barWidth,
                height: BAR_HEIGHT,
                pointerEvents: isFocused ? 'auto' : 'none',
              }}
              onFocus={() => setFocusedTaskId(task.id)}
              onKeyDown={(e) => handleKeyDown(e, task.id)}
            />
          </div>
        );
      })}
    </div>
  );
}
