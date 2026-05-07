import type { TaskAssignee } from '@/types';

export type AssigneeChipsSize = 'sm' | 'md';

interface AssigneeChipsProps {
  assignees: TaskAssignee[];
  /** 'sm' = 16 px circles (default — inline next to task name). 'md' = 24 px (Owner column). */
  size?: AssigneeChipsSize;
  /** Max chips to render before collapsing to a "+N" overflow. Default 2. */
  max?: number;
}

function getInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function chipTitle(a: TaskAssignee): string {
  return `${a.name} (${Math.round(a.units * 100)}%)`;
}

const SIZE_CLASSES: Record<AssigneeChipsSize, string> = {
  sm: 'h-4 w-4 text-xs',
  // 24 px circle, 11 px initials, white halo border to separate overlapping chips.
  md: 'h-6 w-6 text-[11px] border-2 border-neutral-surface',
};

export function AssigneeChips({
  assignees,
  size = 'sm',
  max = 2,
}: AssigneeChipsProps) {
  if (assignees.length === 0) return null;

  const visible = assignees.slice(0, max);
  const overflow = assignees.length - max;
  const sizeClass = SIZE_CLASSES[size];
  // Overlap on 2nd+ at md size only — sm stays gapped to keep dense rows readable.
  const overlapClass = size === 'md' ? '-ml-2 first:ml-0' : '';

  return (
    <span
      className="flex shrink-0 items-center gap-0.5"
      title={
        size === 'md'
          ? assignees.map((a) => `${a.name} (${Math.round(a.units * 100)}%)`).join(', ')
          : undefined
      }
    >
      {visible.map((a) => (
        <span
          key={a.resourceId}
          className={[
            'flex shrink-0 items-center justify-center rounded-full bg-brand-primary/20 font-medium text-neutral-text-primary',
            sizeClass,
            overlapClass,
          ].join(' ')}
          title={size === 'sm' ? chipTitle(a) : undefined}
          aria-hidden="true"
        >
          {getInitials(a.name)}
        </span>
      ))}
      {overflow > 0 && (
        <span
          className={[
            'flex shrink-0 items-center justify-center rounded-full bg-brand-primary/20 font-medium text-neutral-text-primary',
            sizeClass,
            overlapClass,
          ].join(' ')}
          title={
            size === 'sm'
              ? assignees
                  .slice(max)
                  .map((a) => a.name)
                  .join(', ')
              : undefined
          }
          aria-hidden="true"
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}
