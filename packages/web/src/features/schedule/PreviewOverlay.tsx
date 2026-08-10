/**
 * Absolutely-positioned overlay that renders translucent preview bars for
 * all downstream-impacted tasks during a Gantt drag (issue #19) or keyboard
 * reschedule (issue #34), and a dashed build ghost bar during inline name
 * editing in build mode (issue #344).
 *
 * Mounted as canvas layer 4 by `CanvasScheduleTimeline`, above the ARIA
 * overlay. Until #2819 it had no render site at all: it was written against
 * the pre-canvas SVAR Gantt, which had no timeline header and no engine-owned
 * scroll, so its row math (`rowIndex * ROW_HEIGHT`, a `scrollLeft` prop) could
 * not be satisfied by the canvas host — and so the CPM worker's per-task
 * `results` reached no visible surface. It now takes the engine directly and
 * derives scales/scroll from it, the same integration shape as
 * `ScheduleAriaOverlay` (design decision 54).
 *
 * Design rules enforced here:
 * - Rule 23: ghost-fill / ghost-border tokens via style prop (dynamic values)
 * - Rule 24: "preview bars" terminology
 * - Rule 25: critical preview = semantic-critical border; fill stays ghost-fill
 * - Rule 26: CP badge (non-color critical signal, WCAG 1.4.1), shown ≥ 400ms
 * - Rule 27: pointer-events-none aria-hidden="true"
 * - Rule 28: "Esc to cancel" label rendered during pointer drag; keyboard legend in keyboard mode
 * - Rule 32: capped at 10 bars; "+N more" count label
 * - Rule 33: bars animate out only (150ms opacity, motion-safe)
 * - Issue #1493: "Preview" chip labels the whole overlay as a client-side
 *   estimate — the server CPM run reconciles the authoritative dates on drop
 * - Rule 51: keyboard instruction strip rendered when isKeyboardMode is true
 * - Rule 52: origin ghost bar at original task position during keyboard reschedule
 * - Issue #2819: a drag whose origin task is pinned by recorded actuals says so
 *   while the gesture is live, instead of letting the bar snap back unexplained
 */

import { useMemo, useEffect, useRef, useState, type RefObject } from 'react';
import type { GanttEngine, GanttScaleData } from '@/features/schedule/engine';
import type { DragPreviewResult, Task } from '@/types';
import { useDragStore } from '@/stores/dragStore';
import { dateToLeft } from '@/features/schedule/engine';
import { ROW_HEIGHT, BAR_TOP_OFFSET, BAR_HEIGHT } from './engine/GanttHitIndex';
import { HEADER_HEIGHT } from './scheduleConstants';
import { isPinnedByActuals, PINNED_DRAG_EXPLANATION } from './pinnedByActuals';

// Design tokens (defined in tailwind.config.ts / globals.css — applied via style prop per rule 10).
// Ghost colors read the theme-aware --ghost-* channels (slate-500 on light,
// slate-400 on dark) so the border clears WCAG 1.4.11 on both surfaces: the old
// slate-500 @55% literal was 2.12:1 (light) / 1.91:1 (dark). At @0.85 the border
// is 3.6:1 (light) / 4.6:1 (dark) — #2207.
const GHOST_FILL = 'rgb(var(--ghost-fill) / 0.14)';
const GHOST_BORDER = 'rgb(var(--ghost-border) / 0.85)';
const CRITICAL_BORDER = 'var(--color-semantic-critical, #B91C1C)';
// Origin ghost bar: more opaque border to distinguish from downstream previews (rule 52).
// Kept above the preview's 0.85 so the anchor still reads as "more solid"; theme-aware (#2207).
const ORIGIN_BORDER = 'rgb(var(--ghost-border) / 0.95)';
// Build ghost bar: dashed brand-accent (amber) border during inline name editing (#344)
const BUILD_BORDER = 'var(--color-brand-accent, #E8A020)';

/**
 * Vertical placement of a ghost bar inside the clipped bars band.
 *
 * The band's own box already starts at HEADER_HEIGHT (see the render below), so
 * this is row-relative and must NOT add the header again. `BAR_TOP_OFFSET` /
 * `BAR_HEIGHT` come from `GanttHitIndex` — the same constants the renderer draws
 * real bars with, so a ghost lands exactly on the bar it previews rather than
 * near it.
 */
function barTop(rowIndex: number, scrollTop: number): number {
  return rowIndex * ROW_HEIGHT - scrollTop + BAR_TOP_OFFSET;
}

interface PreviewBarProps {
  result: DragPreviewResult;
  scales: GanttScaleData;
  scrollLeft: number;
  scrollTop: number;
  rowIndex: number;
  /** True if this bar has been visible for ≥ 400ms (controls CP badge, rule 26). */
  showCpBadge: boolean;
}

function PreviewBar({
  result,
  scales,
  scrollLeft,
  scrollTop,
  rowIndex,
  showCpBadge,
}: PreviewBarProps) {
  // dateToLeft returns canvas-origin coords (rule 57); subtract scrollLeft for viewport-relative
  const left = dateToLeft(result.earlyStart, scales) - scrollLeft;
  const right = dateToLeft(result.earlyFinish, scales) - scrollLeft;
  const width = Math.max(2, right - left);
  const top = barTop(rowIndex, scrollTop);

  const borderColor = result.isCritical ? CRITICAL_BORDER : GHOST_BORDER;

  return (
    <div
      className="absolute rounded-[3px]"
      style={{
        left,
        top,
        width,
        height: BAR_HEIGHT,
        backgroundColor: GHOST_FILL,
        border: result.isCritical ? `2px solid ${CRITICAL_BORDER}` : `1px solid ${GHOST_BORDER}`,
        outlineColor: borderColor,
      }}
      aria-hidden="true"
    >
      {/* CP badge — non-color signal for critical-path flip (rule 26) */}
      {result.isCritical && showCpBadge && (
        <span
          className="absolute -top-3 right-0 text-xs font-bold leading-none px-0.5 py-px rounded-chip bg-semantic-critical text-neutral-text-inverse"
          aria-hidden="true"
        >
          CP
        </span>
      )}
    </div>
  );
}

/** Dashed ghost bar showing the task's original position during keyboard reschedule (rule 52). */
interface OriginBarProps {
  originStart: string;
  originFinish: string;
  scales: GanttScaleData;
  scrollLeft: number;
  scrollTop: number;
  rowIndex: number;
}

/**
 * A static ghost bar at the task's pre-nudge position (rule 52).
 * Shown only during keyboard reschedule so the user has a visual anchor.
 */
function OriginBar({
  originStart,
  originFinish,
  scales,
  scrollLeft,
  scrollTop,
  rowIndex,
}: OriginBarProps) {
  // dateToLeft returns canvas-origin coords (rule 57); subtract scrollLeft for viewport-relative
  const left = dateToLeft(originStart, scales) - scrollLeft;
  const right = dateToLeft(originFinish, scales) - scrollLeft;
  const width = Math.max(2, right - left);
  const top = barTop(rowIndex, scrollTop);

  return (
    <div
      className="absolute rounded-[3px]"
      style={{
        left,
        top,
        width,
        height: BAR_HEIGHT,
        backgroundColor: 'transparent',
        border: `2px dashed ${ORIGIN_BORDER}`,
        borderStyle: 'dashed',
      }}
      aria-hidden="true"
    />
  );
}

/** Dashed amber bar during build-mode inline name editing — shows where the bar will land (#344). */
interface BuildGhostBarProps {
  ghostStart: string;
  ghostFinish: string;
  scales: GanttScaleData;
  scrollLeft: number;
  scrollTop: number;
  rowIndex: number;
}

function BuildGhostBar({
  ghostStart,
  ghostFinish,
  scales,
  scrollLeft,
  scrollTop,
  rowIndex,
}: BuildGhostBarProps) {
  const left = dateToLeft(ghostStart, scales) - scrollLeft;
  const right = dateToLeft(ghostFinish, scales) - scrollLeft;
  const width = Math.max(4, right - left);
  const top = barTop(rowIndex, scrollTop);

  return (
    <div
      className="absolute rounded-[3px]"
      style={{
        left,
        top,
        width,
        height: BAR_HEIGHT,
        backgroundColor: 'transparent',
        border: `2px dashed ${BUILD_BORDER}`,
        borderStyle: 'dashed',
      }}
      aria-hidden="true"
    />
  );
}

/** Shared chip treatment for the three corner labels. */
const CHIP_CLASS =
  'absolute text-xs text-neutral-text-secondary bg-neutral-surface/80 px-1.5 py-0.5 rounded-chip';

interface Props {
  /**
   * The live engine. `scales` and `scrollLeft` are read from it rather than
   * passed in, so this overlay cannot fall out of step with the canvas it
   * floats over (design decision 54: the engine is the sole integration
   * boundary). Null before the engine mounts — the overlay renders nothing.
   */
  engine: GanttEngine | null;
  /** Tasks in rendered row order — resolves preview results to row indices. */
  tasks: Task[];
  /**
   * The scroll container. `scrollTop` is read from it directly because the
   * engine's `scroll` event carries only `scrollLeft` — the same arrangement
   * `ScheduleAriaOverlay` uses.
   */
  containerRef: RefObject<HTMLDivElement | null>;
}

/**
 * Overlay div that sits above the canvas layers. Must be absolutely
 * positioned and pointer-events-none (rule 27) so all pointer events pass
 * through to the interaction canvas beneath it.
 */
export function PreviewOverlay({ engine, tasks, containerRef }: Props) {
  const phase = useDragStore((s) => s.phase);
  const draggedTaskId = useDragStore((s) => s.draggedTaskId);
  const previewResults = useDragStore((s) => s.previewResults);
  const overflowCount = useDragStore((s) => s.overflowCount);
  const isKeyboardMode = useDragStore((s) => s.isKeyboardMode);
  const buildingTaskId = useDragStore((s) => s.buildingTaskId);
  const buildingStart = useDragStore((s) => s.buildingStart);
  const buildingFinish = useDragStore((s) => s.buildingFinish);

  // Track when we entered 'dragging' phase to enforce the ≥ 400ms CP badge delay (rule 26)
  const dragStartRef = useRef<number | null>(null);
  const [showCpBadge, setShowCpBadge] = useState(false);
  // Both scroll axes are state, not a ref read: a drag can auto-scroll the
  // timeline, and a ghost bar positioned from a ref would stay behind at the
  // pre-scroll offset until some unrelated re-render caught up.
  const [scrollLeft, setScrollLeft] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    if (phase === 'dragging') {
      dragStartRef.current = Date.now();
      setShowCpBadge(false);
      const timer = setTimeout(() => setShowCpBadge(true), 400);
      return () => clearTimeout(timer);
    } else {
      dragStartRef.current = null;
      setShowCpBadge(false);
    }
  }, [phase]);

  // Horizontal scroll comes from the engine (rule 55: always unsubscribe);
  // vertical from the container, which is the only thing that knows it.
  useEffect(() => {
    if (!engine) return;
    setScrollLeft(engine.scrollLeft);
    return engine.on('scroll', ({ scrollLeft: left }) => {
      setScrollLeft(left);
      if (containerRef.current) setScrollTop(containerRef.current.scrollTop);
    });
  }, [engine, containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => setScrollTop(container.scrollTop);
    update();
    container.addEventListener('scroll', update, { passive: true });
    return () => container.removeEventListener('scroll', update);
  }, [containerRef]);

  // Build row-index map from the ordered task list
  const rowIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    tasks.forEach((t, i) => map.set(t.id, i));
    return map;
  }, [tasks]);

  const draggedTask = useMemo(
    () => (draggedTaskId ? (tasks.find((t) => t.id === draggedTaskId) ?? null) : null),
    [tasks, draggedTaskId],
  );

  /**
   * The origin ghost bar (rule 52) is anchored to the dragged task's CURRENT
   * start/finish, which is still its pre-nudge position: a keyboard reschedule
   * previews in the worker and does not touch task data until commit. Pointer
   * drags are excluded because the interaction canvas already paints its own
   * drag shadow for the bar under the cursor.
   */
  const originTask = isKeyboardMode ? draggedTask : null;

  /** #2819: the drop will not move this bar — the drag chrome should say so. */
  const draggedIsPinned = draggedTask != null && isPinnedByActuals(draggedTask);

  const isVisible = phase === 'dragging' || phase === 'committing' || phase === 'building';
  const scales = engine?.scales ?? null;

  if (!isVisible || !scales) return null;

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{
        zIndex: 4,
        // Rule 33: animate out only (opacity transition on exit, no entry animation)
        opacity: phase === 'committing' ? 0 : 1,
        transition: phase === 'committing' ? 'opacity 150ms ease-out' : 'none',
      }}
      aria-hidden="true"
      data-testid="preview-overlay"
    >
      {/* Bars band. Inset below the timeline header and clipped to it, so a ghost
          for a row scrolled up under the header does not paint over the date
          labels. Children are positioned relative to THIS box, which is why
          barTop() is row-relative and adds no header offset. */}
      <div
        className="absolute left-0 right-0 bottom-0 overflow-hidden"
        style={{ top: HEADER_HEIGHT }}
      >
        {/* Build ghost bar — dashed amber placeholder during inline name editing (#344) */}
        {phase === 'building' && buildingTaskId && buildingStart && buildingFinish && (() => {
          const rawIdx = rowIndexMap.get(buildingTaskId);
          // Fall back to end of list when the task is newly created and not yet in tasks
          const rowIndex = rawIdx ?? tasks.length;
          return (
            <BuildGhostBar
              ghostStart={buildingStart}
              ghostFinish={buildingFinish}
              scales={scales}
              scrollLeft={scrollLeft}
              scrollTop={scrollTop}
              rowIndex={rowIndex}
            />
          );
        })()}

        {/* Origin ghost bar — shows the task's pre-nudge position (rule 52) */}
        {originTask && (() => {
          const rowIndex = rowIndexMap.get(originTask.id);
          if (rowIndex === undefined) return null;
          return (
            <OriginBar
              originStart={originTask.start}
              originFinish={originTask.finish}
              scales={scales}
              scrollLeft={scrollLeft}
              scrollTop={scrollTop}
              rowIndex={rowIndex}
            />
          );
        })()}

        {previewResults.map((result) => {
          const rowIndex = rowIndexMap.get(result.taskId);
          if (rowIndex === undefined) return null;
          return (
            <PreviewBar
              key={result.taskId}
              result={result}
              scales={scales}
              scrollLeft={scrollLeft}
              scrollTop={scrollTop}
              rowIndex={rowIndex}
              showCpBadge={showCpBadge}
            />
          );
        })}
      </div>

      {/* Top-left disclosure. Normally the estimate label (issue #1493): the drag
          preview is a client-side approximation (fixed Mon–Fri calendar, no
          custom-calendar/holiday awareness), so a slip or CP badge here reads as
          a prediction rather than the confirmed server result.

          When the dragged bar is pinned by recorded actuals it is replaced by the
          reason the drop will do nothing (#2819). The gesture is deliberately
          left working — the API still accepts the PATCH, so suppressing it would
          remove a write the server still offers — but saying this DURING the drag
          is what the old behaviour lacked: the bar used to land at the drop,
          because `_sync_early_start_to_planned` moves `early_start`
          optimistically, and then snap back on the next CPM run with no
          explanation anywhere. */}
      {phase === 'dragging' && (
        <div
          className={`${CHIP_CLASS} top-1 left-2 ${draggedIsPinned ? '!bg-neutral-surface border border-semantic-at-risk text-semantic-at-risk' : ''}`}
          aria-hidden="true"
          data-testid="preview-disclosure"
        >
          {draggedIsPinned ? PINNED_DRAG_EXPLANATION : 'Preview — server confirms on drop'}
        </div>
      )}

      {/* "+N more affected" label (rule 32) */}
      {overflowCount > 0 && (
        <div className={`${CHIP_CLASS} bottom-1 right-2`} aria-hidden="true">
          +{overflowCount} more affected
        </div>
      )}

      {/* Instruction strip — pointer drag: "Esc to cancel" (rule 28);
          keyboard mode: full key legend (rule 51) */}
      {phase === 'dragging' && (
        <div className={`${CHIP_CLASS} bottom-1 left-2`} aria-hidden="true">
          {isKeyboardMode
            ? '← → Shift+arrow · d date · Enter confirm · Esc cancel'
            : 'Esc to cancel'}
        </div>
      )}
    </div>
  );
}
