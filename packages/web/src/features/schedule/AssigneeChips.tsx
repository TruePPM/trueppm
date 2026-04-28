import type { TaskAssignee } from '@/types';

interface AssigneeChipsProps {
  assignees: TaskAssignee[];
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

const MAX_VISIBLE = 2;

export function AssigneeChips({ assignees }: AssigneeChipsProps) {
  if (assignees.length === 0) return null;

  const visible = assignees.slice(0, MAX_VISIBLE);
  const overflow = assignees.length - MAX_VISIBLE;

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {visible.map((a) => (
        <span
          key={a.resourceId}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-primary/20 text-xs font-medium text-neutral-text-primary"
          title={chipTitle(a)}
          aria-hidden="true"
        >
          {getInitials(a.name)}
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-primary/20 text-xs font-medium text-neutral-text-primary"
          title={assignees
            .slice(MAX_VISIBLE)
            .map((a) => a.name)
            .join(', ')}
          aria-hidden="true"
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}
