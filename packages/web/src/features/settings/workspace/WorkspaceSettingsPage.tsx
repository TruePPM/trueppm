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

function NavIcon({ children }: { children: React.ReactNode }) {
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
    ],
  },
  {
    label: 'Connections',
    items: [
      { id: 'integrations', label: 'Integrations',        to: '/settings/integrations', icon: <NavIcon><SettingsIcon aria-hidden="true" /></NavIcon> },
      { id: 'webhooks',     label: 'Webhooks & API',      to: '/settings/webhooks',     icon: <NavIcon><WbsIcon aria-hidden="true" /></NavIcon> },
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
