/**
 * App-wide running-timer chip in the TopBar right cluster (#1415, ADR-0185 §C).
 *
 * Renders **only while a timer is running** (like `TaskRunIndicator`) — the calm
 * shell stays quiet when idle, and starting a timer is a task-context action
 * that lives on the My Work row, not a header control. The persistent idle
 * "0:00:00 · No timer" affordance with a task picker is the global quick-log
 * popover's job (#1416), not this chip's.
 *
 * The chip shows a pulsing dot, the mono live elapsed (`1:24:06`, derived from
 * the server `started_at`), the task label, and a stop control. Its running tint
 * uses the on-track semantic token, flipping to the critical token once the
 * timer goes `stale` (past the ceiling) so a forgotten timer reads as "check me".
 */
import { useActiveTimer, useElapsedSeconds } from '@/hooks/useActiveTimer';
import { formatElapsed } from '@/lib/formatElapsed';

export function TimerChip() {
  const { timer, stopTimer, isStopping } = useActiveTimer();
  const elapsed = useElapsedSeconds(timer?.started_at ?? null);

  if (!timer) return null;

  const clock = formatElapsed(elapsed);
  const taskLabel = `${timer.task_short_id} · ${timer.task_name}`;
  const tint = timer.stale
    ? 'border-semantic-critical/40 bg-semantic-critical-bg text-semantic-critical'
    : 'border-semantic-on-track/40 bg-semantic-on-track-bg text-semantic-on-track';
  // The stop-glyph cutout must read as a hole punched in the chip, so it fills
  // with the same tint as the chip background (not chrome-surface) and flips
  // with the stale→critical state.
  const holeFill = timer.stale ? 'bg-semantic-critical-bg' : 'bg-semantic-on-track-bg';

  return (
    <div
      className={['flex items-center gap-1.5 rounded-chip border py-0.5 pl-2 pr-0.5', tint].join(' ')}
      role="status"
      // The accessible name is stable and event-driven: it announces once when
      // the timer starts (this region mounts) and does NOT embed the per-second
      // clock — a ticking name floods screen readers (a11y rule). The live clock
      // lives in the aria-hidden span below; `stale` is a discrete state so it
      // may appear in the name.
      aria-label={`Timer running on ${taskLabel}${timer.stale ? ' — running a long time' : ''}`}
    >
      {/* Pulsing dot — the running heartbeat. Decorative. */}
      <span
        className="h-2 w-2 shrink-0 rounded-full bg-current motion-safe:animate-pulse"
        aria-hidden="true"
      />
      <span className="tppm-mono text-xs" aria-hidden="true">
        {clock}
      </span>
      {/* Task label — hidden on the narrowest widths so the chip stays compact. */}
      <span className="hidden max-w-[10rem] truncate text-xs font-medium sm:inline" aria-hidden="true">
        {taskLabel}
      </span>
      <button
        type="button"
        onClick={() => stopTimer()}
        disabled={isStopping}
        aria-label={`Stop timer and log time on ${taskLabel}`}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-control md:h-7 md:w-7
          hover:bg-current/10
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
          disabled:cursor-progress disabled:opacity-60"
      >
        {/* Stop glyph — filled square with a punched hole matching the chip tint. */}
        <span className="grid h-4 w-4 place-items-center rounded-[3px] bg-current" aria-hidden="true">
          <span className={['h-[7px] w-[7px] rounded-[1px]', holeFill].join(' ')} />
        </span>
      </button>
    </div>
  );
}
