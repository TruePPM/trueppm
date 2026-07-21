import type { TaskStatus } from '@/types';

/**
 * Presentation helpers for a task's board status, shared by the risk
 * "Linked tasks" surfaces (#2156). Kept out of the components so the picker and
 * the detail list render the same label + dot color for a given status.
 */

/** Humanize a TaskStatus enum ("IN_PROGRESS" → "In progress"). */
export function formatTaskStatus(status: TaskStatus | null | undefined): string {
  if (!status) return '';
  const lower = status.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Tailwind background class for the status dot. Color encodes meaning
 * (green = done, blue = active, amber = paused, gray = not started) per the
 * design system's semantic color rules.
 */
export function taskStatusDotClass(status: TaskStatus | null | undefined): string {
  switch (status) {
    case 'COMPLETE':
      return 'bg-semantic-on-track';
    case 'IN_PROGRESS':
    case 'REVIEW':
      return 'bg-brand-primary';
    case 'ON_HOLD':
      return 'bg-semantic-at-risk';
    default:
      return 'bg-neutral-text-disabled';
  }
}
