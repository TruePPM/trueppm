import { useRef, type KeyboardEvent } from 'react';
import { useScheduleStore, type ScheduleViewMode } from '@/stores/scheduleStore';

/**
 * Grid ↔ Timeline layout toggle for the Schedule view (issue 1221, v2 redesign
 * epic 1163).
 *
 * - **Grid** — the WBS task-list table is shown to the left of the timeline
 *   (the prototype's `detailed` mode; the layout the app shipped before this
 *   toggle existed).
 * - **Timeline** — the task list is hidden and the canvas spans full width
 *   (the prototype's `simple` mode). Bars stay identifiable because the canvas
 *   renderer draws each task name inline beside its bar.
 *
 * Implemented as the standard segmented-control idiom (web rule 179): a
 * `radiogroup` of `radio` buttons with roving tabindex and the active segment
 * filled with `bg-brand-primary` so the selection is conveyed by fill (not text
 * color alone) and contrasts against the toolbar's `surface-raised` background.
 * ArrowLeft/Right (wrapping) and Home/End move the selection, which commits
 * immediately. The choice persists per-user in the schedule store / localStorage.
 */

const MODES: ReadonlyArray<{ value: ScheduleViewMode; label: string }> = [
  { value: 'grid', label: 'Grid' },
  { value: 'timeline', label: 'Timeline' },
];

export function ScheduleViewModeToggle() {
  const viewMode = useScheduleStore((s) => s.viewMode);
  const setViewMode = useScheduleStore((s) => s.setViewMode);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  // Roving-tabindex arrow-key handling lives on the focusable radios (not the
  // group) so the keyboard contract works without making the group a tab stop.
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const current = MODES.findIndex((m) => m.value === viewMode);
    let next = current;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      next = (current + 1) % MODES.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next = (current - 1 + MODES.length) % MODES.length;
    } else if (e.key === 'Home') {
      next = 0;
    } else if (e.key === 'End') {
      next = MODES.length - 1;
    } else {
      return;
    }
    e.preventDefault();
    setViewMode(MODES[next].value);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="Schedule layout"
      className="inline-flex flex-shrink-0 items-center rounded-control border border-neutral-border h-7 overflow-hidden"
    >
      {MODES.map((m, i) => {
        const selected = m.value === viewMode;
        return (
          <button
            key={m.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => setViewMode(m.value)}
            onKeyDown={onKeyDown}
            className={`h-full px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary ${
              selected
                ? 'bg-brand-primary text-neutral-text-inverse'
                : 'bg-neutral-surface text-neutral-text-secondary hover:bg-neutral-surface-raised'
            }`}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
