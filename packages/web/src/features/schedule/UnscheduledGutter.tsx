import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@/types';
import type { GanttScaleData } from './engine';
import { leftToDate } from './engine';
import { usePromoteTask } from '@/hooks/useTaskMutations';
import { UnscheduledTaskRow } from './UnscheduledTaskRow';
import { UnscheduledDragPreview } from './UnscheduledDragPreview';
import { UnscheduledDropIndicator } from './UnscheduledDropIndicator';

interface UnscheduledGutterProps {
  tasks: Task[];
  projectId: string;
  /** GanttScaleData for converting pointer X → date (passed from ScheduleView). */
  scaleData: GanttScaleData | null;
  /** Ref to the canvas scroll container — used to compute drop coordinates. */
  canvasScrollRef: React.RefObject<HTMLDivElement | null>;
  /** Left offset of the task list panel — gutter header aligns with timeline area. */
  taskListWidth: number;
}

interface DragState {
  task: Task;
  x: number;
  y: number;
  overCanvas: boolean;
  dropDate: string | null;
}

const COLLAPSED_KEY = 'trueppm.gantt.unscheduledGutter.collapsed';

/**
 * Unscheduled gutter — shows tasks with no schedule dates below the Gantt (#213).
 *
 * Drag-to-promote: pointer events on task rows → floating preview → drop on canvas
 * → PATCH {planned_start, status}. Status transitions to IN_PROGRESS when the
 * drop date is today/past (work is starting now); future drops keep status at
 * NOT_STARTED so the board doesn't claim work has begun (#336).
 */
export function UnscheduledGutter({
  tasks,
  projectId,
  scaleData,
  canvasScrollRef,
  taskListWidth,
}: UnscheduledGutterProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === 'true';
    } catch {
      return tasks.length === 0;
    }
  });

  // Auto-expand when tasks appear for the first time
  const prevCountRef = useRef(tasks.length);
  useEffect(() => {
    if (tasks.length > 0 && prevCountRef.current === 0) {
      setCollapsed(false);
    }
    prevCountRef.current = tasks.length;
  }, [tasks.length]);

  const persistCollapsed = useCallback((val: boolean) => {
    setCollapsed(val);
    try { localStorage.setItem(COLLAPSED_KEY, String(val)); } catch { /* ignore */ }
  }, []);

  const [drag, setDrag] = useState<DragState | null>(null);
  const promoteMutation = usePromoteTask();

  // --- Drag start from a row ---
  const handleDragStart = useCallback((task: Task, _pointerId: number, x: number, y: number) => {
    setDrag({ task, x, y, overCanvas: false, dropDate: null });
  }, []);

  // --- Global pointer move/up during drag ---
  useEffect(() => {
    if (!drag) return;

    function onMove(e: PointerEvent) {
      const canvasEl = canvasScrollRef.current;
      if (!canvasEl || !scaleData) {
        setDrag((d) => d ? { ...d, x: e.clientX, y: e.clientY, overCanvas: false, dropDate: null } : null);
        return;
      }
      const rect = canvasEl.getBoundingClientRect();
      const overCanvas =
        e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom;

      let dropDate: string | null = null;
      if (overCanvas) {
        // Convert viewport X → canvas-origin X → date (subtract scrollLeft, rule 57)
        const canvasX = e.clientX - rect.left + canvasEl.scrollLeft;
        dropDate = leftToDate(canvasX, scaleData).toISOString().slice(0, 10);
      }
      setDrag((d) => d ? { ...d, x: e.clientX, y: e.clientY, overCanvas, dropDate } : null);
    }

    function onUp(e: PointerEvent) {
      setDrag((d) => {
        if (!d) return null;
        if (d.overCanvas && d.dropDate) {
          if (!navigator.onLine) {
            // Offline — skip PATCH, toast handled by offline alert in ScheduleView
            return null;
          }
          promoteMutation.mutate({ id: d.task.id, projectId, planned_start: d.dropDate });
        }
        return null;
      });
      void e; // suppress unused warning
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setDrag(null);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [drag, canvasScrollRef, scaleData, projectId, promoteMutation]);

  const handleSetDate = useCallback((task: Task, date: string) => {
    if (!navigator.onLine) return;
    promoteMutation.mutate({ id: task.id, projectId, planned_start: date });
  }, [projectId, promoteMutation]);

  const canvasRect = canvasScrollRef.current?.getBoundingClientRect() ?? null;
  const dropX = drag?.dropDate && canvasRect && scaleData
    ? (() => {
        const canvasEl = canvasScrollRef.current!;
        const leftFromOrigin =
          (new Date(drag.dropDate + 'T00:00:00Z').getTime() - scaleData.start.getTime()) *
          scaleData.pxPerMs;
        return leftFromOrigin - canvasEl.scrollLeft;
      })()
    : null;

  return (
    <>
      {/* Gutter panel */}
      <div
        role="region"
        aria-label="Unscheduled tasks"
        className="flex-shrink-0 border-t-2 border-neutral-border bg-neutral-surface-sunken"
      >
        {/* Header strip */}
        <div
          className="flex items-center h-11"
          style={{ paddingLeft: taskListWidth }}
        >
          <span className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary px-4">
            Unscheduled
          </span>
          <span className="tppm-mono text-xs text-neutral-text-disabled ml-1">
            ({tasks.length})
          </span>
          {tasks.length === 0 && (
            <span className="text-xs italic text-neutral-text-disabled ml-3">
              All tasks have planned dates
            </span>
          )}
          <div className="flex-1" />
          {tasks.length > 0 && (
            <button
              type="button"
              aria-label={collapsed ? 'Expand unscheduled tasks' : 'Collapse unscheduled tasks'}
              onClick={() => persistCollapsed(!collapsed)}
              className="w-8 h-8 flex items-center justify-center mr-2 rounded text-neutral-text-secondary
                hover:text-neutral-text-primary
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              <span
                className={`inline-block transition-transform duration-150 ${collapsed ? '' : 'rotate-180'}`}
                aria-hidden="true"
              >
                ▾
              </span>
            </button>
          )}
        </div>

        {/* Task rows */}
        {!collapsed && tasks.length > 0 && (
          <div
            className="overflow-y-auto"
            style={{
              maxHeight: Math.min(tasks.length * 36 + 4, 320),
              paddingLeft: taskListWidth,
            }}
          >
            {tasks.map((task) => (
              <UnscheduledTaskRow
                key={task.id}
                task={task}
                onDragStart={handleDragStart}
                onSetDate={handleSetDate}
              />
            ))}
          </div>
        )}

        {/* Loading skeleton — shown while promote mutation is in-flight */}
        {promoteMutation.isPending && (
          <div
            aria-busy="true"
            aria-label="Promoting task…"
            style={{ paddingLeft: taskListWidth }}
            className="px-4 py-2"
          >
            <div className="h-9 rounded animate-pulse bg-neutral-border/50" />
          </div>
        )}
      </div>

      {/* Drag preview portal */}
      {drag && createPortal(
        <UnscheduledDragPreview task={drag.task} x={drag.x} y={drag.y} />,
        document.body,
      )}

      {/* Drop indicator portal — only when over canvas with a valid date */}
      {drag?.overCanvas && drag.dropDate && canvasRect && dropX !== null && createPortal(
        <UnscheduledDropIndicator
          x={dropX}
          canvasRect={canvasRect}
          dateLabel={drag.dropDate}
        />,
        document.body,
      )}
    </>
  );
}
