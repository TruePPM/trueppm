import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { SettingsShell, type SettingsNavGroup } from '../SettingsShell';
import {
  OverviewIcon,
  ResourcesIcon,
  WbsIcon,
  SprintIcon,
  SettingsIcon,
  WarningIcon,
} from '@/components/Icons';

/**
 * Shell for the workspace System Health tools (ADR-0146, issue 1248).
 *
 * System Health is a multi-route operational area (overview, dead-letter
 * inspector, retention & purge) — not a dirty-form section — so it stays on its
 * own routes rather than joining the consolidated single-page settings (issue 1248).
 * This wrapper renders the same left rail so the chrome is consistent, with an
 * `<Outlet/>` for the active tool. Every rail item carries a `to`: the config
 * sections link back to the consolidated page at their anchor; the System Health
 * items link between the tools.
 */

/** Inline Activity icon (no lucide-react dep). */
function ActivityNavIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Inline trash icon. */
function RetentionNavIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function NavIcon({ children }: { children: ReactNode }) {
  return <span className="w-4 h-4 inline-flex items-center justify-center shrink-0">{children}</span>;
}

// Every item is a route link (`to`) here — System Health is not part of the
// consolidated scroll page, so its rail navigates. Config sections deep-link
// back to the consolidated page at their anchor.
const NAV_GROUPS: SettingsNavGroup[] = [
  {
    label: 'Organization',
    items: [
      { id: 'general', label: 'General',             to: '/settings#general', icon: <NavIcon><OverviewIcon aria-hidden="true" /></NavIcon> },
      { id: 'members', label: 'Members',             to: '/settings#members', icon: <NavIcon><ResourcesIcon aria-hidden="true" /></NavIcon> },
      { id: 'groups',  label: 'Groups & teams',      to: '/settings#groups',  icon: <NavIcon><WbsIcon aria-hidden="true" /></NavIcon> },
      { id: 'roles',   label: 'Roles & permissions', to: '/settings#roles',   icon: <NavIcon><SettingsIcon aria-hidden="true" /></NavIcon> },
    ],
  },
  {
    label: 'Delivery',
    items: [
      { id: 'methodology', label: 'Methodology defaults', to: '/settings#methodology', icon: <NavIcon><SprintIcon aria-hidden="true" /></NavIcon> },
      { id: 'email',       label: 'Email & SMTP',         to: '/settings#email',       icon: <NavIcon><SettingsIcon aria-hidden="true" /></NavIcon> },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'health',    label: 'System health',    to: '/settings/health',           icon: <NavIcon><ActivityNavIcon /></NavIcon> },
      { id: 'retention', label: 'Retention & purge', to: '/settings/health/retention', icon: <NavIcon><RetentionNavIcon /></NavIcon> },
      { id: 'trash',     label: 'Trash',            to: '/settings/trash',            icon: <NavIcon><RetentionNavIcon /></NavIcon> },
    ],
  },
  {
    label: 'Danger',
    items: [
      { id: 'danger', label: 'Archive / Delete', to: '/settings#danger', icon: <NavIcon><WarningIcon aria-hidden="true" /></NavIcon> },
    ],
  },
];

export function WorkspaceSystemHealthShell() {
  return (
    <SettingsShell
      scope="workspace"
      scopeLinks={[
        { scope: 'workspace', label: 'Workspace', to: '/settings' },
        { scope: 'program', label: 'Program', to: null, disabledReason: 'Switch from the workspace page' },
        { scope: 'project', label: 'Project', to: null, disabledReason: 'Switch from the workspace page' },
      ]}
      contextName="TrueScope Aerospace"
      navGroups={NAV_GROUPS}
    >
      <Outlet />
    </SettingsShell>
  );
}
