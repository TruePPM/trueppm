/**
 * CalendarChip — colored task bar fragment within a calendar week row.
 *
 * isStart / isEnd control which side gets rounded corners so multi-week tasks
 * flow continuously across row boundaries (fragment chips).
 *
 * Token usage (light surface):
 *   - Milestone:  brand-accent border + text (◆ shape + text for WCAG 1.4.1)
 *   - Complete:   semantic-on-track
 *   - Critical:   semantic-critical
 *   - Normal:     brand-primary
 */

import type { CalendarChipData } from './calendarUtils';

interface CalendarChipProps {
  chip: CalendarChipData;
  onClick: (taskId: string) => void;
}

function chipColorClass(chip: CalendarChipData): string {
  if (chip.isMilestone) {
    return 'bg-brand-accent/15 border-brand-accent text-brand-accent-dark';
  }
  if (chip.isComplete) {
    return 'bg-semantic-on-track-bg border-semantic-on-track text-semantic-on-track';
  }
  if (chip.isCritical) {
    return 'bg-semantic-critical-bg border-semantic-critical text-semantic-critical';
  }
  return 'bg-brand-primary/10 border-brand-primary/60 text-brand-primary';
}

function roundedClass(chip: CalendarChipData): string {
  if (chip.isStart && chip.isEnd) return 'rounded';
  if (chip.isStart) return 'rounded-l';
  if (chip.isEnd) return 'rounded-r';
  return 'rounded-none';
}

export function CalendarChip({ chip, onClick }: CalendarChipProps) {
  // The finish fragment carries the "due" marker (issue 1230) — the day the task
  // is due. Milestones already read as a single dated diamond, so they opt out.
  const showDue = chip.isEnd && !chip.isMilestone;
  const ariaLabel = [
    chip.isMilestone ? 'Milestone:' : null,
    chip.taskName,
    chip.isCritical ? ', on critical path' : null,
    chip.isComplete ? ', complete' : null,
    showDue ? ', due' : null,
  ]
    .filter(Boolean)
    .join('');

  return (
    <button
      type="button"
      onClick={() => onClick(chip.taskId)}
      aria-label={ariaLabel}
      className={`
        w-full h-[18px] border px-1
        flex items-center overflow-hidden
        text-xs font-medium leading-none
        focus-visible:outline-none focus-visible:ring-2
        focus-visible:ring-brand-primary focus-visible:ring-offset-1
        ${chipColorClass(chip)} ${roundedClass(chip)}
      `}
    >
      {chip.isMilestone && (
        <span aria-hidden="true" className="mr-0.5 flex-shrink-0">
          ◆
        </span>
      )}
      {chip.isStart && <span className="truncate">{chip.taskName}</span>}
      {showDue && (
        <span
          aria-hidden="true"
          className="ml-auto flex-shrink-0 w-1.5 h-1.5 rounded-full bg-neutral-text-secondary"
        />
      )}
    </button>
  );
}
