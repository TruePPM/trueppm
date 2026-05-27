import type { ReactNode } from 'react';
import { Navigate, useLocation, useParams } from 'react-router';
import type { ProgramHealth } from '@/api/types';
import { useProgram } from '@/hooks/useProgram';
import { usePrograms } from '@/hooks/usePrograms';
import { useProjects } from '@/hooks/useProjects';
import { SettingsShell, type SettingsContextOption, type SettingsNavGroup } from './SettingsShell';
import {
  OverviewIcon,
  WbsIcon,
  ResourcesIcon,
  BarChartIcon,
  SprintIcon,
  RiskIcon,
  SettingsIcon,
  WarningIcon,
} from '@/components/Icons';

function NavIcon({ children }: { children: ReactNode }) {
  return <span className="w-4 h-4 inline-flex items-center justify-center shrink-0">{children}</span>;
}

/** Map a program's health override to the settings pill dot; AUTO → neutral. */
function programHealthDot(health?: ProgramHealth): 'onTrack' | 'atRisk' | 'critical' | null {
  switch (health) {
    case 'ON_TRACK': return 'onTrack';
    case 'AT_RISK':  return 'atRisk';
    case 'CRITICAL': return 'critical';
    default:         return null; // AUTO / undefined
  }
}

/** Sub-page segment after /settings/, defaulting to general — preserved when
    switching to another program's settings so the user stays on the same tab. */
function settingsSubPage(pathname: string): string {
  return pathname.split('/settings/')[1]?.split('/')[0] || 'general';
}

/**
 * Program settings layout — renders the shared SettingsShell with program-scoped
 * nav groups and the page Outlet. Lives at /programs/:programId/settings/*.
 */
export function ProgramSettingsPage() {
  const { programId } = useParams<{ programId: string }>();
  const { data: program } = useProgram(programId);
  const { data: programs } = usePrograms();
  const { data: projects } = useProjects();
  const { pathname } = useLocation();

  if (!programId) return null;

  // Project scope prefers a project belonging to THIS program, else any project;
  // disabled when no projects exist (#776).
  const projectTarget = projects?.find((p) => p.programId === programId)?.id ?? projects?.[0]?.id ?? null;

  // Sibling-program switcher options (#776) — preserve the current sub-page so
  // switching from test → test2 lands on the same settings tab.
  const subPage = settingsSubPage(pathname);
  const contextOptions: SettingsContextOption[] = (programs ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    health: programHealthDot(p.health),
    to: `/programs/${p.id}/settings/${subPage}`,
  }));

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
      label: 'Configuration',
      items: [
        { id: 'integrations', label: 'Integrations', to: `/programs/${programId}/settings/integrations`, icon: <NavIcon><SettingsIcon aria-hidden="true" /></NavIcon> },
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
        { scope: 'project',   label: 'Project',   to: projectTarget ? `/projects/${projectTarget}/settings/general` : null, disabledReason: 'No projects yet' },
      ]}
      contextName={program?.name ?? 'Program settings'}
      contextHealth={programHealthDot(program?.health)}
      contextOptions={contextOptions}
      contextActiveId={programId}
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
