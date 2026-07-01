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

interface Props {
  /** Pixel position of the milestone on the timeline (viewport-relative). */
  milestoneLeft: number | null;
  /** Vertical offset of the Gantt timeline top edge (viewport-relative). */
  timelineTop: number;
}

/**
 * Tooltip anchored to the most-impacted milestone's position on the timeline.
 * Falls back to a centered position if milestoneLeft is unavailable.
 */
export function MilestoneDeltaTooltip({ milestoneLeft, timelineTop }: Props) {
  const phase = useDragStore((s) => s.phase);
  const worst = useDragStore((s) => s.worstMilestone);

  if (phase !== 'dragging' || !worst) return null;

  const { name, baselineFinish, newFinish, deltaDays } = worst;
  const isSlipping = deltaDays > 0;
  const deltaLabel =
    deltaDays === 0
      ? 'On schedule'
      : `${isSlipping ? '+' : ''}${deltaDays}d`;

  const left = milestoneLeft !== null ? milestoneLeft - 80 : 120;

  return (
    <div
      className="fixed z-50 pointer-events-none"
      style={{ left: Math.max(8, left), top: timelineTop + 8 }}
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
        {/* Issue #1493: this delta is a client-side estimate (fixed Mon–Fri
            calendar, no custom-calendar/holiday awareness) — the server CPM
            run reconciles the confirmed date on drop. Font floor (rule 50,
            issue #1023): text-xs, never text-[10px], in features/schedule. */}
        <p className="text-xs text-neutral-text-disabled mt-0.5 leading-tight">
          Estimate — confirmed on drop
        </p>
      </div>
    </div>
  );
}
