/**
 * Role selector for project membership.
 *
 * Renders a native <select> with the four grantable roles (0–3). OWNER (4) is
 * intentionally excluded: the API rejects `new_role >= actor_role` for OWNER
 * actors, so we never present it as an option.
 */
interface RolePickerProps {
  value: number;
  onChange: (role: number) => void;
  disabled?: boolean;
  id?: string;
}

const ROLES: { value: number; label: string; description: string }[] = [
  { value: 0, label: 'Viewer',           description: 'Read-only access to all project data' },
  { value: 1, label: 'Team Member',      description: 'Can log time and update assigned tasks' },
  { value: 2, label: 'Resource Manager', description: 'Can manage the team roster and assignments' },
  { value: 3, label: 'Project Manager',  description: 'Full project control — schedule, baselines, board' },
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
        'disabled:opacity-50 disabled:cursor-not-allowed',
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
