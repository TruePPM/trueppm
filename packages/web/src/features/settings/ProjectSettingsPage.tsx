import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { usePrograms } from '@/hooks/usePrograms';
import { SettingsShell, type SettingsNavGroup } from './SettingsShell';
import {
  OverviewIcon,
  ResourcesIcon,
  SprintIcon,
  WbsIcon,
  SettingsIcon,
  WarningIcon,
} from '@/components/Icons';

function NavIcon({ children }: { children: ReactNode }) {
  return <span className="w-4 h-4 inline-flex items-center justify-center shrink-0">{children}</span>;
}

/**
 * Project settings layout — renders the shared SettingsShell with project-scoped
 * nav groups and the page Outlet. Lives at /projects/:projectId/settings/*.
 */
export function ProjectSettingsPage() {
  const projectId = useProjectId();
  const { data: project } = useProject(projectId);
  const { data: programs } = usePrograms();

  if (!projectId) return null;

  const firstProgramId = programs?.[0]?.id;

  const navGroups: SettingsNavGroup[] = [
    {
      label: 'Setup',
      items: [
        { id: 'general',     label: 'General',        to: `/projects/${projectId}/settings/general`,      icon: <NavIcon><OverviewIcon aria-hidden="true" /></NavIcon> },
        { id: 'access',      label: 'Access',         to: `/projects/${projectId}/settings/access`,       icon: <NavIcon><ResourcesIcon aria-hidden="true" /></NavIcon> },
        { id: 'methodology', label: 'Methodology',    to: `/projects/${projectId}/settings/methodology`,  icon: <NavIcon><SprintIcon aria-hidden="true" /></NavIcon> },
      ],
    },
    {
      label: 'Configuration',
      items: [
        { id: 'workflow',      label: 'Workflow & fields', to: `/projects/${projectId}/settings/workflow`,      icon: <NavIcon><WbsIcon aria-hidden="true" /></NavIcon> },
        { id: 'integrations',  label: 'Integrations',      to: `/projects/${projectId}/settings/integrations`,  icon: <NavIcon><SettingsIcon aria-hidden="true" /></NavIcon> },
        { id: 'notifications', label: 'Notifications',     to: `/projects/${projectId}/settings/notifications`, icon: <NavIcon><SettingsIcon aria-hidden="true" /></NavIcon> },
      ],
    },
    {
      label: 'Danger',
      items: [
        { id: 'lifecycle', label: 'Lifecycle', to: `/projects/${projectId}/settings/lifecycle`, icon: <NavIcon><WarningIcon aria-hidden="true" /></NavIcon> },
      ],
    },
  ];

  return (
    <SettingsShell
      scope="project"
      scopeLinks={[
        { scope: 'workspace', label: 'Workspace', to: '/settings/general' },
        { scope: 'program',   label: 'Program',   to: firstProgramId ? `/programs/${firstProgramId}/settings/general` : '/programs' },
        { scope: 'project',   label: 'Project',   to: `/projects/${projectId}/settings/general` },
      ]}
      contextName={project?.name ?? 'Project settings'}
      navGroups={navGroups}
    />
  );
}

/** Index redirect: /projects/:id/settings → /projects/:id/settings/general */
export function ProjectSettingsIndex() {
  const projectId = useProjectId();
  if (!projectId) return null;
  return <Navigate to={`/projects/${projectId}/settings/general`} replace />;
}
