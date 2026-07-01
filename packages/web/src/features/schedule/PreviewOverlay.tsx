/**
 * Absolutely-positioned overlay that renders translucent preview bars for
 * all downstream-impacted tasks during a Gantt drag (issue #19) or keyboard
 * reschedule (issue #34), and a dashed build ghost bar during inline name
 * editing in build mode (issue #344).
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
 */

import { useMemo, useEffect, useRef, useState } from 'react';
import type { GanttScaleData } from '@/features/schedule/engine';
import type { DragPreviewResult } from '@/types';
import { useDragStore } from '@/stores/dragStore';
import { dateToLeft } from '@/features/schedule/engine';

// Design tokens (defined in tailwind.config.ts — applied via style prop per rule 10)
const GHOST_FILL = 'rgba(100, 116, 139, 0.12)';
const GHOST_BORDER = 'rgba(100, 116, 139, 0.55)';
const CRITICAL_BORDER = 'var(--color-semantic-critical, #B91C1C)';
// Origin ghost bar: more opaque border to distinguish from downstream previews (rule 52)
const ORIGIN_BORDER = 'rgba(100, 116, 139, 0.80)';
// Build ghost bar: dashed brand-accent (amber) border during inline name editing (#344)
const BUILD_BORDER = 'var(--color-brand-accent, #E8A020)';

const BAR_HEIGHT = 18; // rule 14: normal/critical/complete = 18px
const ROW_HEIGHT = 28; // rule 15: task list row height

interface PreviewBarProps {
  result: DragPreviewResult;
  scales: GanttScaleData;
  scrollLeft: number;
  rowIndex: number;
  /** True if this bar has been visible for ≥ 400ms (controls CP badge, rule 26). */
  showCpBadge: boolean;
}

function PreviewBar({ result, scales, scrollLeft, rowIndex, showCpBadge }: PreviewBarProps) {
  // dateToLeft returns canvas-origin coords (rule 57); subtract scrollLeft for viewport-relative
  const left = dateToLeft(result.earlyStart, scales) - scrollLeft;
  const right = dateToLeft(result.earlyFinish, scales) - scrollLeft;
  const width = Math.max(2, right - left);
  const top = rowIndex * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2;

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
  rowIndex: number;
}

/**
 * A static ghost bar at the task's pre-nudge position (rule 52).
 * Shown only during keyboard reschedule so the user has a visual anchor.
 */
function OriginBar({ originStart, originFinish, scales, scrollLeft, rowIndex }: OriginBarProps) {
  // dateToLeft returns canvas-origin coords (rule 57); subtract scrollLeft for viewport-relative
  const left = dateToLeft(originStart, scales) - scrollLeft;
  const right = dateToLeft(originFinish, scales) - scrollLeft;
  const width = Math.max(2, right - left);
  const top = rowIndex * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2;

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
  rowIndex: number;
}

function BuildGhostBar({ ghostStart, ghostFinish, scales, scrollLeft, rowIndex }: BuildGhostBarProps) {
  const left = dateToLeft(ghostStart, scales) - scrollLeft;
  const right = dateToLeft(ghostFinish, scales) - scrollLeft;
  const width = Math.max(4, right - left);
  const top = rowIndex * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2;

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

interface Props {
  scales: GanttScaleData | null;
  scrollLeft: number;
  /** Ordered task ids as rendered in the task list — used to resolve row indices. */
  taskIds: string[];
  /**
   * Original start/finish of the task being keyboard-rescheduled (rule 52).
   * Null during pointer drag (SVAR renders its own drag shadow in that case).
   */
  originTask?: { id: string; start: string; finish: string } | null;
}

/**
 * Overlay div that sits above the SVAR Gantt canvas. Must be absolutely
 * positioned and pointer-events-none (rule 27) so all pointer events pass
 * through to SVAR.
 */
export function PreviewOverlay({ scales, scrollLeft, taskIds, originTask }: Props) {
  const phase = useDragStore((s) => s.phase);
  const previewResults = useDragStore((s) => s.previewResults);
  const overflowCount = useDragStore((s) => s.overflowCount);
  const isKeyboardMode = useDragStore((s) => s.isKeyboardMode);
  const buildingTaskId = useDragStore((s) => s.buildingTaskId);
  const buildingStart = useDragStore((s) => s.buildingStart);
  const buildingFinish = useDragStore((s) => s.buildingFinish);

  // Track when we entered 'dragging' phase to enforce the ≥ 400ms CP badge delay (rule 26)
  const dragStartRef = useRef<number | null>(null);
  const [showCpBadge, setShowCpBadge] = useState(false);

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

  // Build row-index map from the ordered task list
  const rowIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    taskIds.forEach((id, i) => map.set(id, i));
    return map;
  }, [taskIds]);

  const isVisible = phase === 'dragging' || phase === 'committing' || phase === 'building';

  if (!isVisible || !scales) return null;

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      aria-hidden="true"
      // Rule 33: animate out only (opacity transition on exit, no entry animation)
      style={{
        opacity: phase === 'committing' ? 0 : 1,
        transition: phase === 'committing'
          ? 'opacity 150ms ease-out'
          : 'none',
      }}
    >
      {/* Build ghost bar — dashed amber placeholder during inline name editing (#344) */}
      {phase === 'building' && buildingTaskId && buildingStart && buildingFinish && (() => {
        const rawIdx = rowIndexMap.get(buildingTaskId);
        // Fall back to end of list when the task is newly created and not yet in taskIds
        const rowIndex = rawIdx !== undefined ? rawIdx : taskIds.length;
        return (
          <BuildGhostBar
            ghostStart={buildingStart}
            ghostFinish={buildingFinish}
            scales={scales}
            scrollLeft={scrollLeft}
            rowIndex={rowIndex}
          />
        );
      })()}

      {/* Origin ghost bar — shows the task's pre-nudge position (rule 52) */}
      {isKeyboardMode && originTask && (() => {
        const rowIndex = rowIndexMap.get(originTask.id);
        if (rowIndex === undefined) return null;
        return (
          <OriginBar
            originStart={originTask.start}
            originFinish={originTask.finish}
            scales={scales}
            scrollLeft={scrollLeft}
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
            rowIndex={rowIndex}
            showCpBadge={showCpBadge}
          />
        );
      })}

      {/* Estimate disclosure (issue #1493): the drag preview is a client-side
          approximation (fixed Mon–Fri calendar, no custom-calendar/holiday
          awareness) — label it so a slip or CP badge here reads as a
          prediction, not the confirmed server result. */}
      {phase === 'dragging' && (
        <div
          className="absolute top-1 left-2 text-xs text-neutral-text-secondary bg-neutral-surface/80 px-1.5 py-0.5 rounded-chip"
          aria-hidden="true"
        >
          Preview — server confirms on drop
        </div>
      )}

      {/* "+N more affected" label (rule 32) */}
      {overflowCount > 0 && (
        <div
          className="absolute bottom-1 right-2 text-xs text-neutral-text-secondary bg-neutral-surface/80 px-1.5 py-0.5 rounded-chip"
          aria-hidden="true"
        >
          +{overflowCount} more affected
        </div>
      )}

      {/* Instruction strip — pointer drag: "Esc to cancel" (rule 28);
          keyboard mode: full key legend (rule 51) */}
      {phase === 'dragging' && (
        <div
          className="absolute bottom-1 left-2 text-xs text-neutral-text-secondary bg-neutral-surface/80 px-1.5 py-0.5 rounded-chip"
          aria-hidden="true"
        >
          {isKeyboardMode
            ? '← → Shift+arrow · d date · Enter confirm · Esc cancel'
            : 'Esc to cancel'}
        </div>
      )}
    </div>
  );
}
