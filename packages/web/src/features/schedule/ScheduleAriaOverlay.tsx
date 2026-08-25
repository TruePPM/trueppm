/**
 * Transparent DOM overlay providing WCAG 2.1 accessible structure over the
 * canvas.
 *
 * The canvas elements are aria-hidden. This overlay provides the accessible
 * tree: role="listbox" > role="option" per bar, with roving tabindex (#2727,
 * ADR-0776 — was role="grid" > role="row" > role="gridcell", but every row
 * has exactly one interactive cell: there is no horizontal cell-to-cell
 * navigation, so `grid`'s 2D contract never applied.
 *
 * `list`/`listitem` (the issue's literal ask) was tried first and reverted:
 * both axe-core (`aria-allowed-attr` — `listitem` does not permit
 * `aria-selected`) and eslint-plugin-jsx-a11y (`no-noninteractive-tabindex` /
 * `-element-interactions` — `listitem` is a non-interactive role) flag it,
 * because `list`/`listitem` is defined for static content grouping, not a
 * keyboard-navigable, selectable widget. `listbox`/`option` is ARIA's actual
 * role pairing for that — same "one interactive item per row, not a grid"
 * shape the issue was really asking for, plus first-class support for
 * `aria-selected` and roving tabindex. Each option's aria-label is the
 * canonical per-task description (name, duration, dates, critical path); the
 * row wrapper is decorative (role="presentation") and exists only for
 * absolute-position layout.
 *
 * Virtualised to match the canvas render window (same overscan = 5 rows).
 * Tracks scrollTop from engine.on('scroll') and updates focus ring position.
 *
 * Design rules enforced:
 * - Rule 67: ScheduleAriaOverlay is mandatory; canvas aria-hidden="true"
 * - Rule 68: ARIA listbox uses roving tabindex; keyboard nav in overlay
 * - Rule 69: buildTaskAriaLabel canonical format
 */

import { useChartHeaderHeight } from '@/hooks/useChartHeaderHeight';
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import type { DeliveryMode, Task, TaskLink } from '@/types';
import { useDragStore } from '@/stores/dragStore';
import type { GanttEngine } from './engine';
import { dateToLeft, dateToRight } from './engine';
import { BAR_HEIGHT } from './engine/GanttHitIndex';
import { useRowMetrics } from '@/hooks/useRowHeight';
import { sprintBandByTaskId, type SprintBand } from './sprintBands';
import { isPinnedByActuals } from './pinnedByActuals';

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

const DELIVERY_MODE_LABEL: Record<DeliveryMode, string> = {
  waterfall: 'Waterfall',
  scrum: 'Scrum',
  kanban: 'Kanban',
  milestone: 'Milestone',
};

/**
 * Canonical aria-label format (rule 69):
 * "{name}, {durationDays} days, starts {start}, finishes {finish}{cp}{mode}"
 *
 * The delivery-mode suffix (#2727) is the only place this bar's execution
 * mode reaches a screen reader — the visual encoding (gutter/chip/texture,
 * #2727 pt.7) is sighted-only. Omitted when the task carries no mode (the
 * field is optional; a task fetched before the server always resolved a
 * default could still be missing it).
 *
 * `band` closes the same gap for the sprint-window band (#2738). The band is
 * paint on an `aria-hidden` canvas, so without this suffix a screen-reader user
 * has no way to learn that a bar sits inside a sprint window at all. It names
 * the window's DATES, not just the sprint, and calls out a bar that finishes
 * past the window — because membership is not what a sighted user reads off the
 * band. What they read is where the bar sits relative to the window's edges, and
 * a commitment that overruns its sprint is the whole reason to look. Omitted for
 * rows no band covers, which is most rows on a gated plan.
 */
export function buildTaskAriaLabel(task: Task, band?: SprintBand): string {
  const cp = task.isCritical ? ', on the critical path' : '';
  const mode = task.deliveryMode ? `, ${DELIVERY_MODE_LABEL[task.deliveryMode]} delivery` : '';
  let sprint = '';
  if (band) {
    sprint = `, in ${band.name} (${formatAriaDate(band.startDate)} – ${formatAriaDate(band.finishDate)})`;
    if (task.finish && task.finish > band.finishDate) {
      sprint += ', finishes after the sprint window';
    }
  }
  if (!task.start || !task.finish) {
    return `${task.name}, ${task.duration} days, unscheduled${mode}${sprint}`;
  }
  return `${task.name}, ${task.duration} days, starts ${formatAriaDate(task.start)}, finishes ${formatAriaDate(task.finish)}${cp}${mode}${sprint}`;
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
  /** Sprint-window bands (#2738) — the non-visual carrier for the canvas band. */
  sprintBands?: SprintBand[];
  containerRef: RefObject<HTMLDivElement | null>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Keyboard-reschedule is discoverable only if announced (#1031, WCAG 4.1.3):
 * a task can be rescheduled with the keyboard unless it is a summary rollup or
 * pinned by recorded actuals. When such a row is focused, the polite live
 * region names it and states the convention so a screen-reader user who doesn't
 * know it can find it.
 *
 * This predicate MUST stay identical to `tryInitiate`'s in useKeyboardReschedule
 * — it is the announcement of that gate, so a divergence either advertises a
 * shortcut that does nothing or hides one that works. Both now read the shared
 * `isPinnedByActuals` helper rather than each spelling the rule out (#2827):
 * completion alone does not pin a task, and a task complete by progress with no
 * actuals is reschedulable and must be announced as such.
 */
export function rescheduleHint(task: Task): string | null {
  if (task.isSummary || isPinnedByActuals(task)) return null;
  return `${task.name}. Press Enter to open details, Shift+Enter to reschedule via keyboard. Arrow keys to navigate rows.`;
}

export function ScheduleAriaOverlay({
  engine,
  tasks,
  links,
  sprintBands,
  containerRef,
}: ScheduleAriaOverlayProps) {
  // Row geometry follows the pointer class (#2997): 28px on a mouse, 44px on a
  // coarse pointer. Taken from the hook rather than the `ROW_HEIGHT` binding
  // directly, because a read alone would not re-render this overlay when a
  // tablet gains a keyboard — and an overlay row rect that disagrees with the
  // canvas beneath it is a focus ring framing the wrong bar.
  const { rowHeight, barTopOffset } = useRowMetrics();
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState('');
  // Mirror of the engine's selection so each option's aria-selected re-renders
  // when selection changes. Reading engine.selectedTaskIds directly (a mutable
  // Set) never re-renders on canvas-click or the overlay's own Enter/Space, so
  // aria-selected went stale until an unrelated scroll/resize (WCAG 4.1.2, #2185).
  const [selectedTaskIds, setSelectedTaskIds] = useState<ReadonlySet<string>>(
    () => engine?.selectedTaskIds ?? new Set<string>(),
  );
  const gridRef = useRef<HTMLDivElement>(null);
  // Task id whose option should receive DOM focus once it is rendered.
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

  // Track selection from engine events so aria-selected stays in sync with
  // canvas-click and keyboard (Enter/Space) selection (rule 55: always
  // unsubscribe). Re-seed on subscribe in case selection changed between renders.
  useEffect(() => {
    if (!engine) return;
    setSelectedTaskIds(engine.selectedTaskIds);
    const off = engine.on('selection-change', ({ taskIds }) => {
      setSelectedTaskIds(new Set(taskIds));
    });
    return off;
  }, [engine]);

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

  // Band per row (#2738) — the band's text equivalent for screen readers, and
  // the hover recovery path for a name the canvas had to truncate (rule 255):
  // a canvas has no `title`, so the overlay's own row node carries it.
  const sprintBandByTask = useMemo(
    () => sprintBandByTaskId(tasks, sprintBands ?? []),
    [tasks, sprintBands],
  );

  // The chart's row origin — the date ruler plus the cadence rail when one is
  // drawn (#3012). Subscribed rather than read, so the overlay's row rects move
  // with the canvas's the first time a project's sprints resolve; a silent
  // disagreement here puts the focus ring on the neighbouring row.
  const chartHeaderHeight = useChartHeaderHeight();

  // Virtualised row range — viewportHeight is reduced by fixed header band
  const overscan = OVERSCAN_ROWS * rowHeight;
  const minY = scrollTop - overscan;
  const maxY = scrollTop + viewportHeight - chartHeaderHeight + overscan;
  const firstRow = Math.max(0, Math.floor(minY / rowHeight));
  const lastRow = Math.min(tasks.length - 1, Math.ceil(maxY / rowHeight));

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
      `[role="option"][data-task-id="${id}"]`,
    );
    if (cell) {
      pendingFocusRef.current = null;
      cell.focus();
    }
  });

  // Roving tabindex keyboard handler (rule 68). Row navigation is vertical
  // only: each row exposes a single option (the bar), so ArrowLeft/Right
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
          const rowTop = tasks.indexOf(target) * rowHeight;
          const viewH = container.clientHeight - chartHeaderHeight;
          if (rowTop < container.scrollTop) container.scrollTop = rowTop;
          else if (rowTop + rowHeight > container.scrollTop + viewH)
            container.scrollTop = rowTop + rowHeight - viewH;
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
        // Home/End jump to the first/last task (#1776): single-cell rows, so
        // "row start/end" and "listbox start/end" coincide.
        case 'Home':
          e.preventDefault();
          moveTo(tasks[0]);
          break;
        case 'End':
          e.preventDefault();
          moveTo(tasks[tasks.length - 1]);
          break;
        case 'Enter':
          // Enter opens the task detail drawer (#2205, WCAG 2.1.1 consistency:
          // Enter on a focused bar opens details, mirroring the task-list rows
          // and the canvas double-click). Shift+Enter starts a keyboard
          // reschedule instead — see the Shift branch below.
          e.preventDefault();
          if (!engine) break;
          if (e.shiftKey) {
            // Select so the document-level useKeyboardReschedule listener —
            // which fires after this React handler in bubble order — sees the
            // selection and starts the reschedule on this same Shift+Enter
            // (covered by ScheduleAriaOverlay.keyboard.test.tsx; keep that
            // interplay in mind before reordering listeners or making
            // selection async).
            engine.selectTask(taskId);
          } else {
            engine.openTask(taskId);
          }
          break;
        case 'r':
        case 'R':
          // 'r' is the single-key alias for Shift+Enter — start a keyboard
          // reschedule. Selecting hands off to useKeyboardReschedule, which now
          // initiates on Shift+Enter / 'r' rather than plain Enter (#2205).
          e.preventDefault();
          if (engine) engine.selectTask(taskId);
          break;
        case ' ':
          // Space selects a task without rescheduling.
          e.preventDefault();
          if (engine) engine.selectTask(taskId);
          break;
      }
    },
    [tasks, engine, containerRef, rowHeight, chartHeaderHeight],
  );

  const scales = engine?.scales ?? null;

  return (
    <div
      ref={gridRef}
      role="listbox"
      aria-label="Schedule chart"
      aria-describedby="schedule-grid-help"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      {/* Static keyboard help announced when the list is entered (#1031).
          Wording must match the real key map (#1776): Left/Right are the nudge
          keys inside a reschedule; Up/Down navigate rows. */}
      <span id="schedule-grid-help" className="sr-only">
        Use arrow up and down to move between tasks, and Home and End to jump to the first and
        last task. Press Enter to open the focused task&apos;s details. On a reschedulable task,
        press Shift+Enter or R to reschedule it with the keyboard: left and right arrow keys nudge the
        start date, Enter confirms, Escape cancels. Press Space to select a task without
        rescheduling.
      </span>
      {/* Polite live region — names the focused row and its reschedule hint. */}
      <span role="status" aria-live="polite" className="sr-only">
        {liveMessage}
      </span>
      {tasks.slice(firstRow, lastRow + 1).map((task, sliceIdx) => {
        const rowIndex = firstRow + sliceIdx;
        const rowTop = rowIndex * rowHeight + chartHeaderHeight - scrollTop;
        // Roving tabindex: until the user has focused a row, the first task is the
        // tab stop so the listbox is reachable by Tab on initial load. Without the
        // `?? tasks[0]?.id` fallback every option was tabIndex=-1 and keyboard/AT
        // users could not enter it at all (#779).
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
            role="presentation"
            style={{
              position: 'absolute',
              top: rowTop,
              left: 0,
              right: 0,
              height: rowHeight,
              pointerEvents: isFocused ? 'auto' : 'none',
            }}
          >
            <div
              role="option"
              data-task-id={task.id}
              tabIndex={isFocused ? 0 : -1}
              aria-label={buildTaskAriaLabel(task, sprintBandByTask.get(task.id))}
              title={sprintBandByTask.get(task.id)?.name}
              aria-describedby={depDescId}
              aria-selected={selectedTaskIds.has(task.id)}
              aria-setsize={tasks.length}
              aria-posinset={rowIndex + 1}
              className="focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface rounded-control outline-none"
              style={{
                position: 'absolute',
                left: barLeft,
                top: barTopOffset,
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
