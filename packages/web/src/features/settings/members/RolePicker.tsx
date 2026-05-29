/**
 * Role selector for project membership.
 *
 * Renders a native <select> with the four grantable roles (VIEWER through ADMIN).
 * OWNER is intentionally excluded: the API rejects `new_role >= actor_role` for
 * OWNER actors, so we never present it as an option. Ordinals come from the
 * shared role module (ADR-0072) so a future renumber lands in one place.
 */
import { ROLE_VIEWER, ROLE_MEMBER, ROLE_SCHEDULER, ROLE_ADMIN } from '@/lib/roles';

interface RolePickerProps {
  value: number;
  onChange: (role: number) => void;
  disabled?: boolean;
  id?: string;
}

const ROLES: { value: number; label: string; description: string }[] = [
  { value: ROLE_VIEWER, label: 'Viewer', description: 'Read-only access to all project data' },
  {
    value: ROLE_MEMBER,
    label: 'Team Member',
    description: 'Can log time and update assigned tasks',
  },
  {
    value: ROLE_SCHEDULER,
    label: 'Resource Manager',
    description: 'Can manage the team roster and assignments',
  },
  {
    value: ROLE_ADMIN,
    label: 'Project Manager',
    description: 'Full project control — schedule, baselines, board',
  },
];

export function RolePicker({ value, onChange, disabled = false, id }: RolePickerProps) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className={[
        'h-8 rounded border border-neutral-border bg-neutral-surface px-2 py-0 text-sm',
        'text-neutral-text-primary focus-visible:outline-none',
        'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        'disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed disabled:cursor-not-allowed',
      ].join(' ')}
    >
      {ROLES.map((r) => (
        <option key={r.value} value={r.value} title={r.description}>
          {r.label}
        </option>
      ))}
    </select>
  );
}
