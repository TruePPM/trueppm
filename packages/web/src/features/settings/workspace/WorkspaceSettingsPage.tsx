import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useProjects } from '@/hooks/useProjects';
import { usePrograms } from '@/hooks/usePrograms';
import { SettingsShell, type SettingsNavGroup } from '../SettingsShell';
import {
  OverviewIcon,
  ResourcesIcon,
  WbsIcon,
  SprintIcon,
  SettingsIcon,
  WarningIcon,
} from '@/components/Icons';

/** Inline Activity icon for the System Health nav item (no lucide-react dep). */
function ActivityNavIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Inline trash icon for the Retention & purge nav item. */
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

const NAV_GROUPS: SettingsNavGroup[] = [
  {
    label: 'Organization',
    items: [
      { id: 'general',     label: 'General',              to: '/settings/general',     icon: <NavIcon><OverviewIcon aria-hidden="true" /></NavIcon> },
      { id: 'members',     label: 'Members',              to: '/settings/members',     icon: <NavIcon><ResourcesIcon aria-hidden="true" /></NavIcon> },
      { id: 'groups',      label: 'Groups & teams',       to: '/settings/groups',      icon: <NavIcon><WbsIcon aria-hidden="true" /></NavIcon> },
      { id: 'roles',       label: 'Roles & permissions',  to: '/settings/roles',       icon: <NavIcon><SettingsIcon aria-hidden="true" /></NavIcon> },
    ],
  },
  {
    label: 'Delivery',
    items: [
      { id: 'methodology', label: 'Methodology defaults', to: '/settings/methodology', icon: <NavIcon><SprintIcon aria-hidden="true" /></NavIcon> },
      { id: 'email',       label: 'Email & SMTP',         to: '/settings/email',       icon: <NavIcon><SettingsIcon aria-hidden="true" /></NavIcon> },
    ],
  },
  // The "Connections" nav group (Integrations + Webhooks & API) is removed
  // from OSS per ADR-0076 — integration management is project-scoped. The
  // routes themselves (`/settings/integrations`, `/settings/webhooks`) remain
  // as redirect shims so external bookmarks don't 404, and Enterprise
  // re-injects this group via the slot registry to host the workspace hub UI
  // (trueppm-enterprise#114).
  {
    label: 'System',
    items: [
      { id: 'health', label: 'System health', to: '/settings/health', icon: <NavIcon><ActivityNavIcon /></NavIcon> },
      { id: 'retention', label: 'Retention & purge', to: '/settings/health/retention', icon: <NavIcon><RetentionNavIcon /></NavIcon> },
    ],
  },
  {
    label: 'Danger',
    items: [
      { id: 'danger', label: 'Archive / Delete',          to: '/settings/danger',       icon: <NavIcon><WarningIcon aria-hidden="true" /></NavIcon> },
    ],
  },
];

/**
 * Workspace settings layout — renders the shared SettingsShell with workspace
 * nav groups and the page Outlet. Lives at /settings/*.
 */
export function WorkspaceSettingsPage() {
  const { data: projects } = useProjects();
  const { data: programs } = usePrograms();

  const firstProjectId = projects?.[0]?.id;
  const firstProgramId = programs?.[0]?.id;

  return (
    <SettingsShell
      scope="workspace"
      scopeLinks={[
        { scope: 'workspace', label: 'Workspace', to: '/settings/general' },
        { scope: 'program',   label: 'Program',   to: firstProgramId ? `/programs/${firstProgramId}/settings/general` : '/programs' },
        { scope: 'project',   label: 'Project',   to: firstProjectId ? `/projects/${firstProjectId}/settings/general` : '/' },
      ]}
      contextName="TrueScope Aerospace"
      navGroups={NAV_GROUPS}
    />
  );
}

/** Index redirect: /settings → /settings/general */
export function WorkspaceSettingsIndex() {
  return <Navigate to="general" replace />;
}
