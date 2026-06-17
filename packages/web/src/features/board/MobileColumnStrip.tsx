import type { TaskStatus } from '@/types';

/**
 * Per-column health/status dot color.
 *
 * Mirrors `COLUMN_DOT_CLASS` in `BoardView` so the mobile strip dot reads with
 * the *same* status vocabulary as the desktop column-header dot — color is a
 * signal layered on the always-present text label (rule 6), never the sole cue.
 * BACKLOG is mapped for completeness but the band lifts it out of the column
 * set (ADR-0057), so it never reaches the strip.
 */
const STRIP_DOT_CLASS: Record<TaskStatus, string> = {
  BACKLOG: 'bg-neutral-text-disabled',
  NOT_STARTED: 'bg-neutral-text-disabled',
  IN_PROGRESS: 'bg-brand-primary',
  REVIEW: 'bg-brand-accent',
  ON_HOLD: 'bg-neutral-text-disabled',
  COMPLETE: 'bg-semantic-on-track',
};

export interface MobileColumnStripSegment {
  status: TaskStatus;
  /** Full column label, e.g. "In Progress". The strip shows the first word. */
  label: string;
  count: number;
}

interface MobileColumnStripProps {
  segments: MobileColumnStripSegment[];
  /** Index of the currently snapped-to column. */
  activeIndex: number;
  /** Fired when a segment is tapped — the host scrolls the column into view. */
  onJump: (index: number) => void;
}

/**
 * Dot-strip navigation for the mobile snap-scroll board (v3 case 8).
 *
 * On a phone the kanban board can't show four columns at once, so each status
 * column becomes a full-width snap page (see `BoardView`'s mobile reflow). This
 * strip is the map: one segment per column carrying a health dot, the column's
 * first-word name, and its task count. The active segment's bar fills solid;
 * tapping any segment jumps to that column.
 *
 * Each segment is a real `<button>` with a 44px min touch target (rule 5). The
 * dot is `aria-hidden` (rule 6) — the visible label + count and the button's
 * `aria-label` carry the meaning; `aria-current` marks the active column for
 * assistive tech without relying on the solid bar (a color-only cue).
 */
export function MobileColumnStrip({ segments, activeIndex, onJump }: MobileColumnStripProps) {
  return (
    <div
      // role=tablist would imply panels swap; this is a scroll map, so a plain
      // labelled group is the honest semantic (the columns stay mounted).
      role="group"
      aria-label="Board columns"
      data-testid="mobile-column-strip"
      className="flex items-stretch gap-1.5 px-1 pt-2 pb-1"
    >
      {segments.map((seg, i) => {
        const active = i === activeIndex;
        const firstWord = seg.label.split(' ')[0];
        return (
          <button
            key={seg.status}
            type="button"
            onClick={() => onJump(i)}
            aria-current={active ? 'true' : undefined}
            aria-label={`${seg.label}, ${seg.count} task${seg.count !== 1 ? 's' : ''}`}
            data-status={seg.status}
            data-active={active ? 'true' : undefined}
            className="flex-1 min-w-0 min-h-[44px] flex flex-col items-center justify-center gap-1
              rounded-md
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              focus-visible:outline-none"
          >
            {/* Active-state bar — fills solid when active (rule 6: paired with text). */}
            <span
              aria-hidden="true"
              className={[
                'w-full h-[3px] rounded-sm transition-colors duration-150',
                active ? 'bg-neutral-text-primary' : 'bg-neutral-border',
              ].join(' ')}
            />
            <span
              className={[
                'flex items-center gap-1 text-xs truncate',
                active
                  ? 'text-neutral-text-primary font-semibold'
                  : 'text-neutral-text-secondary',
              ].join(' ')}
            >
              <span
                aria-hidden="true"
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STRIP_DOT_CLASS[seg.status] ?? 'bg-neutral-text-disabled'}`}
              />
              <span className="truncate tppm-mono">
                {firstWord} {seg.count}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
