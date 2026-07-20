import type { CSSProperties } from 'react';
import { SettingsPageTitle } from '../SettingsShell';
import { EnterpriseBadge } from '../components/EnterpriseBadge';
import { IDENTITY_VIOLET, tintedChipStyle } from '@/lib/identityColors';

const ROLES = ['Viewer', 'Member', 'Scheduler', 'Admin', 'Owner'] as const;
type Role = (typeof ROLES)[number];

const ROLE_PALETTE: Record<Role, { bg: string; text: string; style?: CSSProperties }> = {
  Viewer: { bg: 'bg-neutral-surface-sunken', text: 'text-neutral-text-secondary' },
  Member: { bg: 'bg-neutral-surface-sunken', text: 'text-neutral-text-secondary' },
  // Amber identity chip: readable on-tint text (rule 86 / #2197) + dark override
  // so the static #FFF3CD tint doesn't flash on the dark settings surface.
  Scheduler: {
    bg: 'bg-brand-accent-light dark:bg-brand-accent/20',
    text: 'text-brand-accent-text dark:text-brand-accent',
  },
  Admin: { bg: 'bg-brand-primary-light', text: 'text-brand-primary' },
  // Owner is a distinct identity hue, not a status — it has no brand/status
  // token, so the single-sourced violet is applied via inline style (see
  // lib/identityColors) rather than a raw bg-[hex] arbitrary-value class.
  Owner: { bg: '', text: '', style: tintedChipStyle(IDENTITY_VIOLET) },
};

// One-line summary of each role. There is deliberately no member count: this
// page has no live member-count source (the role model is a static reference,
// not an API-backed roster), and a hardcoded count would be fiction on a surface
// admins read as an access-review reference (#2165).
const ROLE_DESCRIPTIONS: Record<Role, string> = {
  Viewer: "Read-only across projects they're invited to. Use for execs, auditors.",
  Member: 'Default role. Edit own tasks, log time, view boards.',
  Scheduler: 'Assign resources, manage roster, reschedule, edit the working calendar.',
  Admin: 'Full task/dependency edit; create baselines; manage members.',
  // Owner is the highest project role — it is not the "Admin" role. Keep the
  // vocabulary distinct so the hint does not conflate Owner with Admin (#2165).
  Owner: 'Delete project, transfer ownership, manage membership. Highest role.',
};

interface Capability {
  label: string;
  /** Bit mask: index = role order (Viewer, Member, Scheduler, Admin, Owner) */
  grants: boolean[];
  /**
   * Enterprise-only capability. Drives the inline EE upsell badge so the set of
   * Enterprise rows is data-driven (stays in sync as the Enterprise repo adds
   * capabilities) rather than hardcoded in the render. The badge only shows in
   * the community edition — under Enterprise these capabilities are available.
   */
  ee?: boolean;
}

interface CapabilitySection {
  label: string;
  capabilities: Capability[];
}

const SECTIONS: CapabilitySection[] = [
  {
    label: 'Tasks',
    capabilities: [
      { label: 'View tasks', grants: [true, true, true, true, true] },
      { label: 'Edit own tasks', grants: [false, true, true, true, true] },
      { label: 'Edit any task', grants: [false, false, false, true, true] },
      { label: 'Reschedule (move dates)', grants: [false, false, true, true, true] },
      { label: 'Approve gates', grants: [false, false, false, true, true] },
      { label: 'Delete tasks', grants: [false, false, false, true, true] },
    ],
  },
  {
    label: 'Schedule',
    capabilities: [
      { label: 'Recompute CPM', grants: [false, false, true, true, true] },
      { label: 'Edit dependencies', grants: [false, false, true, true, true] },
      { label: 'Save baseline', grants: [false, false, false, true, true] },
      { label: 'Roll back baseline', grants: [false, false, false, true, true] },
      // Applying/editing the working calendar is a scheduling decision gated
      // Scheduler+ on the server (ProjectViewSet.working_calendars) and in the
      // UI (ProjectCalendarsPage: role >= ROLE_SCHEDULER) — not Admin+ (#2165).
      { label: 'Edit working calendar', grants: [false, false, true, true, true] },
    ],
  },
  {
    label: 'People',
    capabilities: [
      // Resource utilization/heatmap reads are Scheduler+ on the server
      // (ProjectViewSet: utilization/heatmap/resource_allocation) — not Member+.
      { label: 'View resource heatmap', grants: [false, false, true, true, true] },
      { label: 'Assign resources', grants: [false, false, true, true, true] },
      { label: 'Invite members', grants: [false, false, false, true, true] },
      { label: 'Manage groups', grants: [false, false, false, false, true] },
      { label: 'Manage roles', grants: [false, false, false, false, true] },
    ],
  },
  {
    label: 'Project',
    capabilities: [
      { label: 'Create projects', grants: [false, false, false, true, true] },
      { label: 'Edit project settings', grants: [false, false, false, true, true] },
      // ADR-0041 estimation governance: general project settings are Admin+, but
      // methodology and estimation mode are Scheduler-writable (enforced
      // field-by-field in ProjectSerializer.validate) — surface the split (#2165).
      { label: 'Set methodology & estimation mode', grants: [false, false, true, true, true] },
      { label: 'Archive projects', grants: [false, false, false, false, true] },
      { label: 'Delete projects', grants: [false, false, false, false, true] },
      { label: 'Manage custom fields', grants: [false, false, false, true, true] },
    ],
  },
  {
    label: 'Workspace',
    capabilities: [
      { label: 'View audit log', grants: [false, false, false, false, true], ee: true },
      // Basic OIDC/OAuth single sign-on (WorkspaceSsoPage) is part of the
      // Apache-2.0 core (auth carve-out; ADR-0517/ADR-0187 §4) — not Enterprise.
      // Only enforced org-wide SSO and identity governance (SAML/SCIM/LDAP) are
      // Enterprise, and those are not represented by this row, so no EE badge (#2165).
      { label: 'Manage SSO', grants: [false, false, false, false, true] },
      { label: 'Manage integrations', grants: [false, false, false, false, true], ee: true },
      { label: 'Manage billing', grants: [false, false, false, false, true], ee: true },
      // Project/program/workspace data export ships in the OSS core (the CSV
      // export on this very page works in the community edition) — not Enterprise.
      { label: 'Export workspace data', grants: [false, false, false, false, true] },
    ],
  },
];

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 8l4 4 6-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Quote a CSV cell only when it contains a comma, quote, or newline. */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Serialize the static capability matrix to CSV. Exported for unit testing —
 * the matrix is hardcoded (no API), so this is pure and deterministic.
 */
export function buildRolesMatrixCsv(): string {
  const header = ['Section', 'Capability', ...ROLES].map(csvCell).join(',');
  const rows = SECTIONS.flatMap((section) =>
    section.capabilities.map((cap) =>
      [section.label, cap.label, ...cap.grants.map((granted) => (granted ? 'Yes' : 'No'))]
        .map(csvCell)
        .join(','),
    ),
  );
  return [header, ...rows].join('\n');
}

function exportRolesMatrixCsv(): void {
  const blob = new Blob([buildRolesMatrixCsv()], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'trueppm-roles-matrix.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Workspace > Roles & permissions RBAC matrix. */
export function WorkspaceRolesPage() {
  // This is an intentional READ-ONLY reference, not a stub awaiting an API (#1649).
  // The five-role model is fixed in the community edition; editing roles / custom
  // roles is an Enterprise capability (two-repo rule), so there is no OSS write
  // path to wire — a "changes won't be saved yet" banner would promise wiring that
  // never lands. The Enterprise boundary is surfaced instead: the custom-roles
  // affordance below and the per-capability EE badges (web-rule 121). EnterpriseBadge
  // self-gates on edition — it renders only under community, so no edition check here.
  return (
    <div>
      <SettingsPageTitle
        title="Roles & permissions"
        subtitle="Five built-in roles map cleanly to how project teams actually work. This matrix is a read-only reference. Custom roles, and the capabilities marked EE, are part of TruePPM Enterprise."
        action={
          <div className="flex gap-2">
            <button
              type="button"
              onClick={exportRolesMatrixCsv}
              className="px-3 py-1.5 rounded-control border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              Export matrix
            </button>
          </div>
        }
      />

      {/* Custom-roles Enterprise affordance (web-rule 121). The badge IS the
          reachable upsell link; it self-suppresses under the Enterprise edition,
          where custom roles are actually available. */}
      <div className="px-6 pt-1 pb-3">
        <p className="max-w-[720px] text-[13px] text-neutral-text-secondary">
          Need custom roles or per-capability permissions? Role definitions are fixed in the
          community edition. Custom roles and granular permission editing are part of TruePPM
          Enterprise.
          <EnterpriseBadge />
        </p>
      </div>

      <div>
        {/* Read-only reference: the role model is static and permanently
            uneditable in OSS, so the cards + matrix render directly (no disabled
            fieldset, no preview banner). Export stays functional (#594). */}
        {/* Role summary cards */}
        <div className="px-6 pt-2 pb-4">
          <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
            {ROLES.map((role) => {
              const hint = ROLE_DESCRIPTIONS[role];
              const { bg, text, style } = ROLE_PALETTE[role];
              return (
                <div
                  key={role}
                  className="rounded-card border border-neutral-border bg-neutral-surface-raised p-3 flex flex-col gap-1.5"
                >
                  <div className="flex items-center">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-chip text-[11px] font-semibold ${bg} ${text}`}
                      style={style}
                    >
                      {role}
                    </span>
                  </div>
                  <p className="text-[12px] text-neutral-text-secondary leading-snug">{hint}</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Matrix — a real <table> so assistive tech associates each grant cell
            with its role column header (scope="col") and capability row header
            (scope="row"), satisfying WCAG 1.3.1 (#2165). The prior CSS-grid divs
            carried no header/cell relationship. */}
        <div className="px-6 pb-8" data-testid="roles-matrix">
          <div className="rounded-card border border-neutral-border overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">
                Role capability matrix: which of the five built-in roles (Viewer, Member, Scheduler,
                Admin, Owner) grants each capability.
              </caption>
              <colgroup>
                <col style={{ width: '38%' }} />
                {ROLES.map((r) => (
                  <col key={r} />
                ))}
              </colgroup>
              <thead>
                <tr className="bg-neutral-surface-sunken border-b border-neutral-border">
                  <th
                    scope="col"
                    className="px-4 py-2.5 text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary text-left"
                  >
                    Capability
                  </th>
                  {ROLES.map((r) => (
                    <th
                      key={r}
                      scope="col"
                      className="px-2 py-2.5 text-[12px] font-semibold text-neutral-text-primary text-center"
                    >
                      {r}
                    </th>
                  ))}
                </tr>
              </thead>

              {SECTIONS.map((sec) => (
                <tbody key={sec.label}>
                  {/* Section group header spanning the full row. */}
                  <tr>
                    <th
                      scope="colgroup"
                      colSpan={ROLES.length + 1}
                      className="px-4 py-2 text-left text-[11px] font-bold tracking-[.08em] uppercase text-neutral-text-secondary bg-neutral-surface border-b border-neutral-border/55 font-mono"
                    >
                      {sec.label}
                    </th>
                  </tr>

                  {sec.capabilities.map((cap, ci) => (
                    <tr
                      key={cap.label}
                      className={
                        ci < sec.capabilities.length - 1 ? 'border-b border-neutral-border/55' : ''
                      }
                    >
                      <th
                        scope="row"
                        className="px-4 py-2.5 text-[13px] font-normal text-neutral-text-primary text-left"
                      >
                        {cap.label}
                        {cap.ee && <EnterpriseBadge />}
                      </th>
                      {cap.grants.map((granted, i) => (
                        <td key={i} className="px-2 py-2.5 text-center">
                          <span className="inline-flex justify-center">
                            <span className="sr-only">{granted ? 'Granted' : 'Not granted'}</span>
                            {granted ? (
                              <span
                                aria-hidden="true"
                                className="w-[18px] h-[18px] rounded-full bg-sage-500 text-navy-900 inline-flex items-center justify-center"
                              >
                                <CheckIcon />
                              </span>
                            ) : (
                              <span
                                aria-hidden="true"
                                className="w-[18px] h-[18px] rounded-full border border-dashed border-neutral-border"
                              />
                            )}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
