/**
 * Role selector for project or program membership.
 *
 * Renders a native <select> with the four grantable roles (VIEWER through ADMIN).
 * OWNER is intentionally excluded: the API rejects `new_role >= actor_role` for
 * OWNER actors, so we never present it as an option. Ordinals come from the
 * shared role module (ADR-0072) so a future renumber lands in one place, and the
 * option *labels* come from `@/lib/roleLabels` so this control and the read-only
 * badge that replaces it name the same ordinal identically (#3476).
 *
 * `scope` is not cosmetic: ordinal 300 is "Project Manager" on a project and
 * "Program Manager" on a program, and this control renders on both. It defaults
 * to `'project'` because that is what every pre-#3476 call site meant.
 *
 * A native `<select>` has no "no match" state: given `value={250}` over options
 * `[1, 100, 200, 300]` the browser selects and paints the FIRST one, so a member
 * holding an Enterprise custom-band role (ADR-0072 reserves 2-99 / 101-199 /
 * 201-299 / 301-399) would be shown as a Viewer and any change the manager then
 * made would fire from a false baseline. The read side already degrades honestly
 * (`roleLabel` falls back to the server's own string), so the write side must
 * too: an unrecognized value gets a `disabled` option carrying its real name,
 * selected. The role stays visible, it cannot be silently re-baselined, and it
 * cannot be re-granted — which is right, because this client does not know what
 * that band means.
 */
import { GRANTABLE_ROLES, roleDescription, roleLabel, type RoleScope } from '@/lib/roleLabels';

interface RolePickerProps {
  value: number;
  onChange: (role: number) => void;
  disabled?: boolean;
  id?: string;
  /**
   * Accessible name when no associated <label> supplies one (e.g. a member row,
   * where the name is per-row and there is nowhere to put a visible label).
   * REQUIRED in that case — a `<select>` with only an `id` announces as a bare
   * "combo box" (axe `select-name`, critical). Prefer an explicit string over
   * `aria-labelledby` pointing at the row's name node: accname trims each text
   * node before joining, so a name cell holding `{username}` plus a `(you)` span
   * computes as "alice(you)".
   */
  ariaLabel?: string;
  /** Which container's role vocabulary to render. Defaults to `'project'`. */
  scope?: RoleScope;
  /**
   * The `role_label` the API sent for the current `value`. Used only when `value`
   * falls outside the grantable set, to name the disabled option that then
   * represents it. Pass it wherever the membership is in hand.
   */
  valueLabel?: string | null;
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
    'disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed',
  ].join(' '),
};

export function RolePicker({
  value,
  onChange,
  disabled = false,
  id,
  ariaLabel,
  scope = 'project',
  valueLabel,
  variant = 'compact',
}: RolePickerProps) {
  // A value with no matching option is swallowed by the browser, not reported —
  // see the module docstring. Rendering the extra option is what makes the
  // control state the role the record actually holds.
  const isUngrantable = !GRANTABLE_ROLES.includes(value);
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
      {isUngrantable && (
        <option value={value} disabled>
          {roleLabel(value, scope, valueLabel)}
        </option>
      )}
      {GRANTABLE_ROLES.map((r) => (
        <option key={r} value={r} title={roleDescription(r, scope)}>
          {roleLabel(r, scope)}
        </option>
      ))}
    </select>
  );
}
