import { Navigate, useParams } from 'react-router';
import { useProgram } from '@/hooks/useProgram';
import { useProjects } from '@/hooks/useProjects';
import { SettingsShell, type SettingsNavGroup } from './SettingsShell';
import {
  OverviewIcon,
  WbsIcon,
  ResourcesIcon,
  BarChartIcon,
  SprintIcon,
  RiskIcon,
  WarningIcon,
} from '@/components/Icons';

function NavIcon({ children }: { children: React.ReactNode }) {
  return <span className="w-4 h-4 inline-flex items-center justify-center shrink-0">{children}</span>;
}

/**
 * Program settings layout — renders the shared SettingsShell with program-scoped
 * nav groups and the page Outlet. Lives at /programs/:programId/settings/*.
 */
export function ProgramSettingsPage() {
  const { programId } = useParams<{ programId: string }>();
  const { data: program } = useProgram(programId);
  const { data: projects } = useProjects();

  if (!programId) return null;

  const firstProjectId = projects?.[0]?.id;

  const navGroups: SettingsNavGroup[] = [
    {
      label: 'Program',
      items: [
        { id: 'general',  label: 'General',     to: `/programs/${programId}/settings/general`,  icon: <NavIcon><OverviewIcon aria-hidden="true" /></NavIcon> },
        { id: 'projects', label: 'Projects',    to: `/programs/${programId}/settings/projects`, icon: <NavIcon><WbsIcon aria-hidden="true" /></NavIcon> },
        { id: 'access',   label: 'Access',      to: `/programs/${programId}/settings/access`,   icon: <NavIcon><ResourcesIcon aria-hidden="true" /></NavIcon> },
        { id: 'rollup',   label: 'Rollup KPIs', to: `/programs/${programId}/settings/rollup`,   icon: <NavIcon><BarChartIcon aria-hidden="true" /></NavIcon> },
        { id: 'cadence',  label: 'Cadence',     to: `/programs/${programId}/settings/cadence`,  icon: <NavIcon><SprintIcon aria-hidden="true" /></NavIcon> },
        { id: 'risk',     label: 'Risk policy', to: `/programs/${programId}/settings/risk`,     icon: <NavIcon><RiskIcon aria-hidden="true" /></NavIcon> },
      ],
    },
    {
      label: 'Danger',
      items: [
        { id: 'lifecycle', label: 'Archive / Close', to: `/programs/${programId}/settings/lifecycle`, icon: <NavIcon><WarningIcon aria-hidden="true" /></NavIcon> },
      ],
    },
  ];

  return (
    <SettingsShell
      scope="program"
      scopeLinks={[
        { scope: 'workspace', label: 'Workspace', to: '/settings/general' },
        { scope: 'program',   label: 'Program',   to: `/programs/${programId}/settings/general` },
        { scope: 'project',   label: 'Project',   to: firstProjectId ? `/projects/${firstProjectId}/settings/general` : '/' },
      ]}
      contextName={program?.name ?? 'Program settings'}
      contextHealth="onTrack"
      navGroups={navGroups}
    />
  );
}

/** Index redirect: /programs/:id/settings → /programs/:id/settings/general */
export function ProgramSettingsIndex() {
  const { programId } = useParams<{ programId: string }>();
  if (!programId) return null;
  return <Navigate to={`/programs/${programId}/settings/general`} replace />;
}
