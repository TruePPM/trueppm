import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { HealthState } from '@/types';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { usePrograms } from '@/hooks/usePrograms';
import { useProjects } from '@/hooks/useProjects';
import { SettingsShell, type SettingsContextOption, type SettingsNavGroup } from './SettingsShell';
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

/** Map a project's health state to the settings pill dot; unknown → neutral. */
function projectHealthDot(health?: HealthState): 'onTrack' | 'atRisk' | 'critical' | null {
  switch (health) {
    case 'on-track': return 'onTrack';
    case 'at-risk':  return 'atRisk';
    case 'critical': return 'critical';
    default:         return null; // unknown / undefined
  }
}

/**
 * Project settings layout — renders the shared SettingsShell with project-scoped
 * nav groups and the page Outlet. Lives at /projects/:projectId/settings/*.
 */
export function ProjectSettingsPage() {
  const projectId = useProjectId();
  const { data: project } = useProject(projectId);
  const { data: programs } = usePrograms();
  const { data: projects } = useProjects();
  const { pathname } = useLocation();

  if (!projectId) return null;

  // Program scope lands on THIS project's parent program (#776) — not an arbitrary
  // first program. Standalone projects fall through to the first program; only
  // when the workspace has no programs at all is the Program scope disabled.
  const parentProgramId = projects?.find((p) => p.id === projectId)?.programId ?? null;
  const programTarget = parentProgramId ?? programs?.[0]?.id ?? null;

  // Sibling-project switcher options (#776) — preserve the current sub-page.
  const subPage = pathname.split('/settings/')[1]?.split('/')[0] || 'general';
  const contextOptions: SettingsContextOption[] = (projects ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    health: projectHealthDot(p.healthState),
    to: `/projects/${p.id}/settings/${subPage}`,
  }));
  const activeProjectHealth = projects?.find((p) => p.id === projectId)?.healthState;

  // Team facet-assignment tab is methodology-gated (ADR-0078, #927): agile/hybrid
  // only. The §F single-team-invisibility rule governs multi-team chrome, not this
  // tab, so it is gated by methodology rather than team count in 0.3 (waterfall
  // projects never see Team UI). HYBRID is the default for pre-methodology rows.
  const showTeamTab = project?.methodology === 'AGILE' || project?.methodology === 'HYBRID';

  const navGroups: SettingsNavGroup[] = [
    {
      label: 'Setup',
      items: [
        { id: 'general',     label: 'General',        to: `/projects/${projectId}/settings/general`,      icon: <NavIcon><OverviewIcon aria-hidden="true" /></NavIcon> },
        { id: 'access',      label: 'Access',         to: `/projects/${projectId}/settings/access`,       icon: <NavIcon><ResourcesIcon aria-hidden="true" /></NavIcon> },
        { id: 'methodology', label: 'Methodology',    to: `/projects/${projectId}/settings/methodology`,  icon: <NavIcon><SprintIcon aria-hidden="true" /></NavIcon> },
        ...(showTeamTab
          ? [{ id: 'team', label: 'Team', to: `/projects/${projectId}/settings/team`, icon: <NavIcon><ResourcesIcon aria-hidden="true" /></NavIcon> }]
          : []),
      ],
    },
    {
      label: 'Configuration',
      items: [
        { id: 'workflow',      label: 'Workflow & fields', to: `/projects/${projectId}/settings/workflow`,      icon: <NavIcon><WbsIcon aria-hidden="true" /></NavIcon> },
        { id: 'guardrails',    label: 'Sprint guardrails', to: `/projects/${projectId}/settings/guardrails`,    icon: <NavIcon><WarningIcon aria-hidden="true" /></NavIcon> },
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
        { scope: 'program',   label: 'Program',   to: programTarget ? `/programs/${programTarget}/settings/general` : null, disabledReason: 'No programs yet' },
        { scope: 'project',   label: 'Project',   to: `/projects/${projectId}/settings/general` },
      ]}
      contextName={project?.name ?? 'Project settings'}
      contextHealth={projectHealthDot(activeProjectHealth)}
      contextOptions={contextOptions}
      contextActiveId={projectId}
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
