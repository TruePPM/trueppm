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
 * - Rule 67: ScheduleAriaOverlay is mandatory; canvas aria-hidden="true"
 * - Rule 68: ARIA grid uses roving tabindex; keyboard nav in overlay
 * - Rule 69: buildTaskAriaLabel canonical format
 */

import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import type { Task, TaskLink } from '@/types';
import { useDragStore } from '@/stores/dragStore';
import type { GanttEngine } from './engine';
import { dateToLeft, dateToRight } from './engine';
import { ROW_HEIGHT, BAR_TOP_OFFSET, BAR_HEIGHT } from './engine/GanttHitIndex';
import { HEADER_HEIGHT } from './scheduleConstants';

const OVERSCAN_ROWS = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAriaDate(isoDate: string): string {
  if (!isoDate) return 'unscheduled';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(isoDate + 'T00:00:00Z'));
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

/**
 * Builds a per-task dependency description map for aria-describedby.
 *
 * Returns a Map<taskId, string> where each entry describes the task's
 * predecessor and/or successor links in plain English, e.g.:
 *   "Depends on: Design (FS, +2d); Planning (SS). Leads to: Build (FS)."
 *
 * Tasks with no links are omitted from the map. Exported for unit testing.
 */
export function buildDepDescription(tasks: Task[], links: TaskLink[]): Map<string, string> {
  if (links.length === 0) return new Map();

  const nameById = new Map<string, string>();
  for (const t of tasks) nameById.set(t.id, t.name);

  // Group links by target (predecessors) and by source (successors).
  const byTarget = new Map<string, TaskLink[]>();
  const bySource = new Map<string, TaskLink[]>();
  for (const link of links) {
    const preds = byTarget.get(link.targetId) ?? [];
    preds.push(link);
    byTarget.set(link.targetId, preds);

    const succs = bySource.get(link.sourceId) ?? [];
    succs.push(link);
    bySource.set(link.sourceId, succs);
  }

  const formatLink = (link: TaskLink, peerId: string): string => {
    const name = nameById.get(peerId) ?? 'Unknown task';
    const lag =
      link.lag !== 0 ? `, ${link.lag > 0 ? '+' : ''}${link.lag}d` : '';
    return `${name} (${link.type}${lag})`;
  };

  const desc = new Map<string, string>();
  for (const task of tasks) {
    const preds = byTarget.get(task.id) ?? [];
    const succs = bySource.get(task.id) ?? [];
    const parts: string[] = [];

    if (preds.length > 0) {
      const predStr = preds.map((l) => formatLink(l, l.sourceId)).join('; ');
      parts.push(`Depends on: ${predStr}`);
    }
    if (succs.length > 0) {
      const succStr = succs.map((l) => formatLink(l, l.targetId)).join('; ');
      parts.push(`Leads to: ${succStr}`);
    }
    if (parts.length > 0) desc.set(task.id, parts.join('. ') + '.');
  }
  return desc;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ScheduleAriaOverlayProps {
  engine: GanttEngine | null;
  tasks: Task[];
  /** Dependency edges — drives per-bar aria-describedby dep announcements (#1371). */
  links: TaskLink[];
  containerRef: RefObject<HTMLDivElement | null>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Keyboard-reschedule is discoverable only if announced (#1031, WCAG 4.1.3):
 * a task can be rescheduled with the keyboard unless it is a summary rollup or
 * already complete (mirrors the gate in useKeyboardReschedule). When such a row
 * is focused, the polite live region names it and states the Enter convention
 * so a screen-reader user who doesn't know it can find it.
 */
export function rescheduleHint(task: Task): string | null {
  if (task.isSummary || task.isComplete) return null;
  return `${task.name}. Press Enter to reschedule via keyboard. Arrow keys to navigate rows.`;
}

export function ScheduleAriaOverlay({
  engine,
  tasks,
  links,
  containerRef,
}: ScheduleAriaOverlayProps) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState('');
  const gridRef = useRef<HTMLDivElement>(null);
  // Task id whose gridcell should receive DOM focus once it is rendered.
  const pendingFocusRef = useRef<string | null>(null);

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

  // Per-task dep description strings for aria-describedby (#1371).
  const depDescriptions = useMemo(() => buildDepDescription(tasks, links), [tasks, links]);

  // Virtualised row range — viewportHeight is reduced by fixed header band
  const overscan = OVERSCAN_ROWS * ROW_HEIGHT;
  const minY = scrollTop - overscan;
  const maxY = scrollTop + viewportHeight - HEADER_HEIGHT + overscan;
  const firstRow = Math.max(0, Math.floor(minY / ROW_HEIGHT));
  const lastRow = Math.min(tasks.length - 1, Math.ceil(maxY / ROW_HEIGHT));

  // After keyboard navigation re-renders the roving tab stop, move DOM focus
  // to it. Without this the next keydown still fires on the *previous* cell
  // (whose task index it carries), so navigation stalled after a single step.
  // No dependency array: after a far jump (Home/End) the target row only
  // mounts once the container's scroll event updates the virtualized window,
  // a later render this effect must also observe.
  useEffect(() => {
    const id = pendingFocusRef.current;
    if (!id) return;
    const cell = gridRef.current?.querySelector<HTMLElement>(
      `[role="gridcell"][data-task-id="${id}"]`,
    );
    if (cell) {
      pendingFocusRef.current = null;
      cell.focus();
    }
  });

  // Roving tabindex keyboard handler (rule 68). Row navigation is vertical
  // only: each row exposes a single gridcell (the bar), so ArrowLeft/Right
  // have no sibling cell to move to and are deliberately left unhandled —
  // they are the nudge keys once a keyboard reschedule is active
  // (useKeyboardReschedule, document-level).
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, taskId: string) => {
      // While a keyboard reschedule is active the document-level handler owns
      // the keys (Left/Right nudge, Enter confirm, Escape cancel) — the grid
      // must not move its roving focus or re-select mid-reschedule.
      if (useDragStore.getState().isKeyboardMode) return;

      const moveTo = (target: Task | undefined) => {
        if (!target) return;
        setFocusedTaskId(target.id);
        // Announce the reschedule convention for reschedulable rows; stay
        // silent on summary/complete rows to avoid spamming (#1031).
        setLiveMessage(rescheduleHint(target) ?? '');
        pendingFocusRef.current = target.id;
        // Bring the row into the virtualized window (Home/End can jump far
        // outside it) and the bar into horizontal view.
        const container = containerRef.current;
        if (container) {
          const rowTop = tasks.indexOf(target) * ROW_HEIGHT;
          const viewH = container.clientHeight - HEADER_HEIGHT;
          if (rowTop < container.scrollTop) container.scrollTop = rowTop;
          else if (rowTop + ROW_HEIGHT > container.scrollTop + viewH)
            container.scrollTop = rowTop + ROW_HEIGHT - viewH;
        }
        if (engine) engine.scrollToDate(target.start);
      };

      const idx = tasks.findIndex((t) => t.id === taskId);
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          moveTo(tasks[idx + 1]);
          break;
        case 'ArrowUp':
          e.preventDefault();
          moveTo(tasks[idx - 1]);
          break;
        // role="grid" keyboard contract (#1776): Home/End jump to the first/
        // last row (single-cell rows, so "row start/end" and "grid start/end"
        // coincide).
        case 'Home':
          e.preventDefault();
          moveTo(tasks[0]);
          break;
        case 'End':
          e.preventDefault();
          moveTo(tasks[tasks.length - 1]);
          break;
        case 'Enter':
        case ' ':
          // Selects the task. The engine emits `selection-change`
          // synchronously, so for Enter the document-level
          // useKeyboardReschedule listener — which fires after this React
          // handler in bubble order — sees the selection and starts the
          // keyboard reschedule on this same keydown (covered by
          // ScheduleAriaOverlay.keyboard.test.tsx; keep that interplay in
          // mind before reordering listeners or making selection async).
          e.preventDefault();
          if (engine) engine.selectTask(taskId);
          break;
      }
    },
    [tasks, engine, containerRef],
  );

  const scales = engine?.scales ?? null;

  return (
    <div
      ref={gridRef}
      role="grid"
      aria-rowcount={tasks.length}
      aria-label="Schedule chart"
      aria-describedby="schedule-grid-help"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      {/* Static keyboard help announced when the grid is entered (#1031).
          Wording must match the real key map (#1776): Left/Right are the nudge
          keys inside a reschedule; Up/Down navigate rows. */}
      <span id="schedule-grid-help" className="sr-only">
        Use arrow up and down to move between tasks, and Home and End to jump to the first and
        last task. Press Enter on a reschedulable task to reschedule it with the keyboard: left
        and right arrow keys nudge the start date, Enter confirms, Escape cancels. Press Space to
        select a task without rescheduling.
      </span>
      {/* Polite live region — names the focused row and its reschedule hint. */}
      <span role="status" aria-live="polite" className="sr-only">
        {liveMessage}
      </span>
      {tasks.slice(firstRow, lastRow + 1).map((task, sliceIdx) => {
        const rowIndex = firstRow + sliceIdx;
        const rowTop = rowIndex * ROW_HEIGHT + HEADER_HEIGHT - scrollTop;
        // Roving tabindex: until the user has focused a row, the first task is the
        // tab stop so the grid is reachable by Tab on initial load. Without the
        // `?? tasks[0]?.id` fallback every cell was tabIndex=-1 and keyboard/AT
        // users could not enter the grid at all (#779).
        const isFocused = task.id === (focusedTaskId ?? tasks[0]?.id);

        // Bar geometry for focus ring positioning (rule 68)
        let barLeft = 0;
        let barWidth = 0;
        if (scales) {
          barLeft = dateToLeft(task.start, scales) - (engine?.scrollLeft ?? 0);
          // finish is inclusive — match the canvas bar's true (exclusive) right
          // edge so the focus ring frames the whole bar (#950). Milestones
          // (start == finish, drawn as a diamond) keep their narrow ring.
          const barRight = task.isMilestone
            ? dateToLeft(task.finish, scales) - (engine?.scrollLeft ?? 0)
            : dateToRight(task.finish, scales) - (engine?.scrollLeft ?? 0);
          barWidth = Math.max(2, barRight - barLeft);
        }

        const depDesc = depDescriptions.get(task.id);
        const depDescId = depDesc ? `schedule-deps-${task.id}` : undefined;

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
              data-task-id={task.id}
              tabIndex={isFocused ? 0 : -1}
              aria-label={buildTaskAriaLabel(task)}
              aria-describedby={depDescId}
              aria-selected={engine?.selectedTaskIds.has(task.id)}
              className="focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface rounded-control outline-none"
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
            {/* Hidden dep description read by aria-describedby when the bar is focused. */}
            {depDesc && (
              <span id={depDescId} className="sr-only">
                {depDesc}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
