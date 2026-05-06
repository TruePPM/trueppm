import type { TaskStatus } from '@/types';

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

export function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
