/**
 * Floating tooltip showing the most-impacted milestone delta during drag (rule 31).
 *
 * Mounts at ScheduleView level (not inside CanvasScheduleTimeline) to escape overflow:hidden.
 * Positions itself near the worst milestone's bar on the timeline.
 *
 * Design rules:
 * - Rule 31: mounts at ScheduleView level
 * - Only visible during 'dragging' phase
 * - No pointer events (read-only informational overlay)
 */

import { useDragStore } from '@/stores/dragStore';
import { formatShortDate } from '@/features/schedule/scheduleUtils';
import { milestoneX } from './engine';
import type { GanttScaleData } from './engine';

/** Tooltip card width in px — matches the `w-44` class below. */
const TOOLTIP_WIDTH = 176;
const VIEWPORT_MARGIN = 8;
const FALLBACK_LEFT = 120;

interface Props {
  /** Pixel position of the milestone on the timeline (viewport-relative). */
  milestoneLeft: number | null;
  /** Vertical offset of the Gantt timeline top edge (viewport-relative). */
  timelineTop: number;
  /** Leftmost allowed viewport x — keeps the card off the task-list panel. */
  minLeft?: number;
}

/**
 * Tooltip anchored to the most-impacted milestone's position on the timeline.
 * Falls back to a centered position if milestoneLeft is unavailable.
 */
export function MilestoneDeltaTooltip({
  milestoneLeft,
  timelineTop,
  minLeft = VIEWPORT_MARGIN,
}: Props) {
  const phase = useDragStore((s) => s.phase);
  const worst = useDragStore((s) => s.worstMilestone);

  if (phase !== 'dragging' || !worst) return null;

  const { name, baselineFinish, newFinish, deltaDays } = worst;
  const isSlipping = deltaDays > 0;
  const deltaLabel = deltaDays === 0 ? 'On schedule' : `${isSlipping ? '+' : ''}${deltaDays}d`;

  // A NaN anchor (e.g. a scale not yet measured) would render `left: NaN`; fall back to
  // the fixed position instead. Clamp both edges so a milestone near the right edge of
  // the viewport does not push the card off-screen.
  const raw =
    milestoneLeft !== null && Number.isFinite(milestoneLeft) ? milestoneLeft - 80 : FALLBACK_LEFT;
  const floor = Math.max(VIEWPORT_MARGIN, minLeft);
  const maxLeft = Math.max(floor, window.innerWidth - TOOLTIP_WIDTH - VIEWPORT_MARGIN);
  const left = Math.min(maxLeft, Math.max(floor, raw));

  return (
    <div
      className="fixed z-50 pointer-events-none"
      style={{ left, top: timelineTop + 8 }}
      aria-hidden="true"
    >
      <div className="bg-neutral-surface border border-neutral-border rounded-card px-2.5 py-1.5 shadow-none text-xs w-44">
        <p className="font-medium text-neutral-text-primary truncate">{name}</p>
        <div className="flex items-center justify-between mt-1">
          <span className="text-neutral-text-secondary">{formatShortDate(baselineFinish)}</span>
          <span className="mx-1 text-neutral-text-disabled">→</span>
          <span
            className={
              isSlipping
                ? 'text-semantic-critical font-semibold'
                : 'text-semantic-on-track font-semibold'
            }
          >
            {formatShortDate(newFinish)}
          </span>
        </div>
        <p
          className={`text-right font-bold mt-0.5 ${isSlipping ? 'text-semantic-critical' : 'text-semantic-on-track'}`}
        >
          {deltaLabel}
        </p>
        {/* Issue #1493: this delta is a client-side estimate (the browser's
            forward pass, on the project calendar since #4170) — the server CPM
            run reconciles the confirmed date on drop. Font floor (rule 50,
            issue #1023): text-xs, never text-xs, in features/schedule. */}
        <p className="text-xs text-neutral-text-disabled mt-0.5 leading-tight">
          Estimate — confirmed on drop
        </p>
      </div>
    </div>
  );
}

interface AnchorProps {
  /** The split-pane container as state (web rule 279), or null before it mounts. */
  timelineEl: HTMLElement | null;
  canvasScrollRef: { current: HTMLElement | null };
  /** Width of the outline panel left of the canvas. */
  panelWidth: number;
  scales: GanttScaleData | null;
}

/**
 * Positions {@link MilestoneDeltaTooltip} over the worst milestone's finish.
 *
 * Subscribes to the drag store itself, so it re-renders on every preview update
 * and reads the container rect and scroll offset fresh during a drag. Until the
 * container or scales exist it passes `null`, which the tooltip renders at its
 * fixed fallback rather than not at all.
 */
export function MilestoneDeltaAnchor({
  timelineEl,
  canvasScrollRef,
  panelWidth,
  scales,
}: AnchorProps) {
  const worst = useDragStore((s) => s.worstMilestone);
  // The worst-milestone payload carries the day-end flag itself (#4079): the preview
  // results are capped, so the milestone may not be among them. The Gantt draws the
  // diamond at `milestoneX`.
  const atDayEnd = worst?.milestoneAtDayEnd;
  const rect = timelineEl ? timelineEl.getBoundingClientRect() : null;
  let milestoneLeft: number | null = null;
  if (rect && scales && worst) {
    // milestoneX returns canvas-origin coordinates (renderer rule §57); the tooltip
    // is fixed-position in viewport space, so add the container's left and the
    // outline panel and subtract the canvas scroll.
    milestoneLeft =
      rect.left +
      panelWidth +
      milestoneX(worst.newFinish, atDayEnd, scales) -
      (canvasScrollRef.current?.scrollLeft ?? 0);
  }
  return (
    <MilestoneDeltaTooltip
      milestoneLeft={milestoneLeft}
      timelineTop={rect?.top ?? 0}
      minLeft={rect ? rect.left + panelWidth + VIEWPORT_MARGIN : VIEWPORT_MARGIN}
    />
  );
}
