import type { Task, TaskStatus } from '@/types';

/**
 * Fill color for a task's progress bar: critical tasks read red, completed
 * tasks read green, everything else uses the brand primary. Shared by the
 * Flat/Grouped `TaskRow` and the Outline `OutlineRow` so the two stay in sync.
 */
export function progressBarColor(task: Pick<Task, 'isCritical' | 'isComplete'>): string {
  if (task.isCritical) return 'bg-semantic-critical';
  if (task.isComplete) return 'bg-semantic-on-track';
  return 'bg-brand-primary';
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  BACKLOG:      'Backlog',
  NOT_STARTED:  'Not started',
  IN_PROGRESS:  'In progress',
  REVIEW:       'Review',
  ON_HOLD:      'On hold',
  COMPLETE:     'Done',
};

const STATUS_CLS: Record<TaskStatus, string> = {
  BACKLOG:      'border-neutral-border text-neutral-text-secondary',
  NOT_STARTED:  'border-neutral-border text-neutral-text-secondary',
  IN_PROGRESS:  'border-brand-primary/50 text-brand-primary',
  REVIEW:       'border-brand-accent/50 text-brand-accent-dark',
  ON_HOLD:      'border-semantic-warning/50 text-semantic-warning',
  COMPLETE:     'border-semantic-on-track/50 text-semantic-on-track',
};

export function StatusPill({ status }: { status: TaskStatus }) {
  return (
    <span
      className={`inline-flex items-center h-5 px-1.5 border rounded text-xs font-medium
        ${STATUS_CLS[status] ?? STATUS_CLS.NOT_STARTED}`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return (parts[0]?.[0] ?? '').toUpperCase();
  return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
}

export function OwnerAvatar({ name }: { name: string }) {
  return (
    <span
      aria-label={name}
      title={name}
      className="w-6 h-6 rounded-full bg-brand-primary/20 text-brand-primary
        flex items-center justify-center text-xs font-semibold"
    >
      {initials(name)}
    </span>
  );
}

/**
 * A read-only CPM float cell for the Flat/Grouped table (#3344).
 *
 * `hidden lg:flex` matches the header's own `hidden lg:block` — the two must
 * carry the same breakpoint or the body drifts a column out of alignment with
 * the heading above it, which no type check can see.
 *
 * Null means CPM has not run for this row and renders an em-dash, never `0d`:
 * "no answer yet" and "no slack at all" are opposite readings, and the second
 * one is the alarming one. Negative float is the one value that changes what a
 * reader does next, so it takes the critical colour AND semibold weight AND
 * keeps its minus sign — colour is never the sole carrier (web rules 12/120).
 */
export function GridFloatCell({
  value,
  label,
}: {
  value: number | null | undefined;
  label: 'Total float' | 'Free float';
}) {
  const late = typeof value === 'number' && value < 0;
  return (
    <span
      role="gridcell"
      aria-label={
        value === null || value === undefined
          ? `${label}: not computed yet`
          : late
            ? `${label}: ${Math.abs(value)} working days late`
            : `${label}: ${value} working ${value === 1 ? 'day' : 'days'}`
      }
      className={[
        'hidden lg:flex items-center justify-end flex-shrink-0 tppm-mono text-xs',
        'lg:w-16 lg:text-right lg:pr-2',
        late ? 'text-semantic-critical font-semibold' : 'text-neutral-text-secondary',
      ].join(' ')}
    >
      {value === null || value === undefined ? '—' : `${value}d`}
    </span>
  );
}

export function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
