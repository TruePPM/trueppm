/**
 * Absolutely-positioned overlay that renders translucent preview bars for
 * all downstream-impacted tasks during a Gantt drag (issue #19).
 *
 * Design rules enforced here:
 * - Rule 23: ghost-fill / ghost-border tokens via style prop (dynamic values)
 * - Rule 24: "preview bars" terminology
 * - Rule 25: critical preview = semantic-critical border; fill stays ghost-fill
 * - Rule 26: CP badge (non-color critical signal, WCAG 1.4.1), shown ≥ 400ms
 * - Rule 27: pointer-events-none aria-hidden="true"
 * - Rule 28: "Esc to cancel" label rendered during drag
 * - Rule 32: capped at 10 bars; "+N more" count label
 * - Rule 33: bars animate out only (150ms opacity, motion-safe)
 */

import { useMemo, useEffect, useRef, useState } from 'react';
import type { GanttScaleData } from '@svar-ui/gantt-store/dist/types/types';
import type { DragPreviewResult } from '@/types';
import { useDragStore } from '@/stores/dragStore';
import { dateToLeft } from '@/features/gantt/ganttUtils';

// Design tokens (defined in tailwind.config.ts — applied via style prop per rule 10)
const GHOST_FILL = 'rgba(100, 116, 139, 0.12)';
const GHOST_BORDER = 'rgba(100, 116, 139, 0.55)';
const CRITICAL_BORDER = 'var(--color-semantic-critical, #B91C1C)';

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
  const left = dateToLeft(result.earlyStart, scales, scrollLeft);
  const right = dateToLeft(result.earlyFinish, scales, scrollLeft);
  const width = Math.max(2, right - left);
  const top = rowIndex * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2;

  const borderColor = result.isCritical ? CRITICAL_BORDER : GHOST_BORDER;

  return (
    <div
      className="absolute rounded-sm"
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
          className="absolute -top-3 right-0 text-[9px] font-bold leading-none px-0.5 py-px rounded-sm bg-semantic-critical text-neutral-text-inverse"
          aria-hidden="true"
        >
          CP
        </span>
      )}
    </div>
  );
}

interface Props {
  scales: GanttScaleData | null;
  scrollLeft: number;
  /** Ordered task ids as rendered in the task list — used to resolve row indices. */
  taskIds: string[];
}

/**
 * Overlay div that sits above the SVAR Gantt canvas. Must be absolutely
 * positioned and pointer-events-none (rule 27) so all pointer events pass
 * through to SVAR.
 */
export function PreviewOverlay({ scales, scrollLeft, taskIds }: Props) {
  const phase = useDragStore((s) => s.phase);
  const previewResults = useDragStore((s) => s.previewResults);
  const overflowCount = useDragStore((s) => s.overflowCount);

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

  const isVisible = phase === 'dragging' || phase === 'committing';

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

      {/* "+N more affected" label (rule 32) */}
      {overflowCount > 0 && (
        <div
          className="absolute bottom-1 right-2 text-[10px] text-neutral-text-secondary bg-neutral-surface/80 px-1.5 py-0.5 rounded"
          aria-hidden="true"
        >
          +{overflowCount} more affected
        </div>
      )}

      {/* "Esc to cancel" label (rule 28) */}
      {phase === 'dragging' && (
        <div
          className="absolute bottom-1 left-2 text-[10px] text-neutral-text-secondary bg-neutral-surface/80 px-1.5 py-0.5 rounded"
          aria-hidden="true"
        >
          Esc to cancel
        </div>
      )}
    </div>
  );
}
