import type { CSSProperties } from 'react';
import { SettingsPageTitle } from '../SettingsShell';
import { EnterpriseBadge } from '../components/EnterpriseBadge';
import { IDENTITY_VIOLET, tintedChipStyle } from '@/lib/identityColors';

const ROLES = ['Viewer', 'Member', 'Scheduler', 'Admin', 'Owner'] as const;
type Role = (typeof ROLES)[number];

const ROLE_PALETTE: Record<Role, { bg: string; text: string; style?: CSSProperties }> = {
  Viewer: { bg: 'bg-neutral-surface-sunken', text: 'text-neutral-text-secondary' },
  Member: { bg: 'bg-neutral-surface-sunken', text: 'text-neutral-text-secondary' },
  Scheduler: { bg: 'bg-brand-accent-light', text: 'text-brand-accent-dark' },
  Admin: { bg: 'bg-brand-primary-light', text: 'text-brand-primary' },
  // Owner is a distinct identity hue, not a status — it has no brand/status
  // token, so the single-sourced violet is applied via inline style (see
  // lib/identityColors) rather than a raw bg-[hex] arbitrary-value class.
  Owner: { bg: '', text: '', style: tintedChipStyle(IDENTITY_VIOLET) },
};

const ROLE_DESCRIPTIONS: Record<Role, { count: number; hint: string }> = {
  Viewer: {
    count: 18,
    hint: "Read-only across projects they're invited to. Use for execs, auditors.",
  },
  Member: { count: 32, hint: 'Default role. Edit own tasks, log time, view boards.' },
  Scheduler: { count: 12, hint: 'Assign resources, manage roster. No task edit.' },
  Admin: { count: 6, hint: 'Full task/dependency edit; create baselines; manage members.' },
  Owner: { count: 2, hint: 'Project Admin: delete project, manage membership. Highest role.' },
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
      { label: 'Edit working calendar', grants: [false, false, false, true, true] },
    ],
  },
  {
    label: 'People',
    capabilities: [
      { label: 'View resource heatmap', grants: [false, true, true, true, true] },
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
      { label: 'Archive projects', grants: [false, false, false, false, true] },
      { label: 'Delete projects', grants: [false, false, false, false, true] },
      { label: 'Manage custom fields', grants: [false, false, false, true, true] },
    ],
  },
  {
    label: 'Workspace',
    capabilities: [
      { label: 'View audit log', grants: [false, false, false, false, true], ee: true },
      { label: 'Manage SSO', grants: [false, false, false, false, true], ee: true },
      { label: 'Manage integrations', grants: [false, false, false, false, true], ee: true },
      { label: 'Manage billing', grants: [false, false, false, false, true], ee: true },
      { label: 'Export workspace data', grants: [false, false, false, false, true], ee: true },
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
              const { count, hint } = ROLE_DESCRIPTIONS[role];
              const { bg, text, style } = ROLE_PALETTE[role];
              return (
                <div
                  key={role}
                  className="rounded-card border border-neutral-border bg-neutral-surface-raised p-3 flex flex-col gap-1.5"
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-chip text-[11px] font-semibold ${bg} ${text}`}
                      style={style}
                    >
                      {role}
                    </span>
                    <span className="tppm-mono text-[11px] text-neutral-text-secondary">
                      {count} people
                    </span>
                  </div>
                  <p className="text-[12px] text-neutral-text-secondary leading-snug">{hint}</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Matrix */}
        <div className="px-6 pb-8" data-testid="roles-matrix">
          <div className="rounded-card border border-neutral-border overflow-hidden">
            {/* Header */}
            <div
              className="grid gap-2 px-4 py-2.5 bg-neutral-surface-sunken border-b border-neutral-border"
              style={{ gridTemplateColumns: '2.4fr repeat(5, 1fr)' }}
            >
              <span className="text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary">
                Capability
              </span>
              {ROLES.map((r) => (
                <span
                  key={r}
                  className="text-[12px] font-semibold text-neutral-text-primary text-center"
                >
                  {r}
                </span>
              ))}
            </div>

            {/* Sections */}
            {SECTIONS.map((sec) => (
              <div key={sec.label}>
                {/* Section label */}
                <div className="px-4 py-2 text-[11px] font-bold tracking-[.08em] uppercase text-neutral-text-secondary bg-neutral-surface border-b border-neutral-border/55 font-mono">
                  {sec.label}
                </div>

                {/* Capability rows */}
                {sec.capabilities.map((cap, ci) => (
                  <div
                    key={cap.label}
                    className={[
                      'grid gap-2 px-4 py-2.5 items-center',
                      ci < sec.capabilities.length - 1 ? 'border-b border-neutral-border/55' : '',
                    ].join(' ')}
                    style={{ gridTemplateColumns: '2.4fr repeat(5, 1fr)' }}
                  >
                    <span className="text-[13px] text-neutral-text-primary">
                      {cap.label}
                      {cap.ee && <EnterpriseBadge />}
                    </span>
                    {cap.grants.map((granted, i) => (
                      <span
                        key={i}
                        className="flex justify-center"
                        aria-label={granted ? 'Granted' : 'Not granted'}
                      >
                        {granted ? (
                          <span className="w-[18px] h-[18px] rounded-full bg-sage-500 text-navy-900 inline-flex items-center justify-center">
                            <CheckIcon />
                          </span>
                        ) : (
                          <span className="w-[18px] h-[18px] rounded-full border border-dashed border-neutral-border" />
                        )}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
