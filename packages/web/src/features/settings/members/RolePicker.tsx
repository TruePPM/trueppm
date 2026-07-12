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
  /** Accessible name when no associated <label> supplies one (e.g. inline settings). */
  ariaLabel?: string;
  /**
   * `'compact'` (default) — the dense `h-8` control used inline in member rows and
   * the settings density zone. `'form'` — the `h-9 rounded-control` field styling
   * used beside other form fields (e.g. the New project dialog) so adjacent selects
   * match in height, radius, and chevron.
   */
  variant?: 'compact' | 'form';
}

// Custom chevron matching the app's form <select> styling (appearance-none).
const FORM_CHEVRON =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 16 16'><path d='M4 6l4 4 4-4' stroke='%23667085' stroke-width='2' stroke-linecap='round' fill='none' /></svg>\")";

const VARIANT_CLASSES: Record<NonNullable<RolePickerProps['variant']>, string> = {
  compact: [
    'h-8 rounded border border-neutral-border bg-neutral-surface px-2 py-0 text-sm',
    'text-neutral-text-primary focus-visible:outline-none',
    'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
    'disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed',
  ].join(' '),
  form: [
    'h-9 pl-3 pr-8 rounded-control border border-neutral-border bg-neutral-surface text-sm',
    'text-neutral-text-primary appearance-none bg-no-repeat bg-[right_0.5rem_center]',
    'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1',
    'disabled:opacity-50 disabled:cursor-not-allowed',
  ].join(' '),
};

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

export function RolePicker({
  value,
  onChange,
  disabled = false,
  id,
  ariaLabel,
  variant = 'compact',
}: RolePickerProps) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(Number(e.target.value))}
      style={variant === 'form' ? { backgroundImage: FORM_CHEVRON } : undefined}
      className={VARIANT_CLASSES[variant]}
    >
      {ROLES.map((r) => (
        <option key={r.value} value={r.value} title={r.description}>
          {r.label}
        </option>
      ))}
    </select>
  );
}
