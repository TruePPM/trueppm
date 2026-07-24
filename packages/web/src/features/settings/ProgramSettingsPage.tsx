import type { ReactNode } from 'react';
import { useParams } from 'react-router';
import type { ProgramHealth } from '@/api/types';
import { useIsWorkspaceAdmin } from '@/hooks/useIsWorkspaceAdmin';
import { useProgram } from '@/hooks/useProgram';
import { usePrograms } from '@/hooks/usePrograms';
import { useProjects } from '@/hooks/useProjects';
import {
  SettingsShell,
  SettingsSection,
  type SettingsContextOption,
  type SettingsNavGroup,
} from './SettingsShell';
import { ProgramGeneralPage } from './program/ProgramGeneralPage';
import { ProgramProjectsPage } from './program/ProgramProjectsPage';
import { ProgramAccessPage } from './program/ProgramAccessPage';
import { ProgramStakeholdersPage } from './program/ProgramStakeholdersPage';
import { ProgramRollupPage } from './program/ProgramRollupPage';
import { ProgramCadencePage } from './program/ProgramCadencePage';
import { ProgramCalendarPage } from './program/ProgramCalendarPage';
import { ProgramRiskPolicyPage } from './program/ProgramRiskPolicyPage';
import { ProgramIntegrationsPage } from './program/ProgramIntegrationsPage';
import { ProgramAttachmentsPage } from './program/ProgramAttachmentsPage';
import { ProgramArchivePage } from './program/ProgramArchivePage';
import {
  OverviewIcon,
  WbsIcon,
  ResourcesIcon,
  BarChartIcon,
  SprintIcon,
  RiskIcon,
  SettingsIcon,
  ExternalLinkIcon,
  WarningIcon,
  GanttIcon,
} from '@/components/Icons';

function NavIcon({ children }: { children: ReactNode }) {
  return (
    <span className="w-4 h-4 inline-flex items-center justify-center shrink-0">{children}</span>
  );
}

/** Map a program's health override to the settings pill dot; AUTO → neutral. */
function programHealthDot(health?: ProgramHealth): 'onTrack' | 'atRisk' | 'critical' | null {
  switch (health) {
    case 'ON_TRACK':
      return 'onTrack';
    case 'AT_RISK':
      return 'atRisk';
    case 'CRITICAL':
      return 'critical';
    default:
      return null; // AUTO / undefined
  }
}

/**
 * Program settings — ONE scrolling page (ADR-0146, issue 1248). Lives at
 * /programs/:programId/settings; sub-slugs redirect to `#<slug>`. Sections are
 * reused unchanged inside anchored `<SettingsSection>` regions.
 */
export function ProgramSettingsPage() {
  const { programId } = useParams<{ programId: string }>();
  const { data: program } = useProgram(programId);
  const { data: programs } = usePrograms();
  const { data: projects } = useProjects();
  // The Workspace scope tab links to `/settings`, which RequireWorkspaceAdmin
  // bounces a non-workspace-admin away from (#2012). Disable the tab (rather than
  // render a dead link) when the user is positively not a workspace admin.
  const isWorkspaceAdmin = useIsWorkspaceAdmin();

  if (!programId) return null;

  // Project scope prefers a project belonging to THIS program, else any (issue 776).
  const projectTarget =
    projects?.find((p) => p.programId === programId)?.id ?? projects?.[0]?.id ?? null;

  // Sibling-program switcher options (issue 776).
  const contextOptions: SettingsContextOption[] = (programs ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    health: programHealthDot(p.health),
    to: `/programs/${p.id}/settings`,
  }));

  const navGroups: SettingsNavGroup[] = [
    {
      label: 'Program',
      items: [
        {
          id: 'general',
          label: 'General',
          keywords: 'name description code program',
          icon: (
            <NavIcon>
              <OverviewIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        {
          id: 'projects',
          label: 'Projects',
          keywords: 'member projects add remove grouping',
          icon: (
            <NavIcon>
              <WbsIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        {
          id: 'access',
          label: 'Access',
          keywords: 'members permissions roles visibility rbac',
          icon: (
            <NavIcon>
              <ResourcesIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        {
          id: 'stakeholders',
          label: 'External stakeholders',
          keywords: 'sponsors contacts external people governance',
          icon: (
            <NavIcon>
              <ExternalLinkIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        {
          id: 'rollup',
          label: 'Rollup KPIs',
          keywords: 'metrics kpi aggregate health dashboard indicators',
          icon: (
            <NavIcon>
              <BarChartIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        {
          id: 'cadence',
          label: 'Cadence',
          keywords: 'rhythm sync meetings frequency schedule reporting',
          icon: (
            <NavIcon>
              <SprintIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        {
          id: 'calendar',
          label: 'Working calendar',
          keywords: 'holidays working days hours timezone',
          icon: (
            <NavIcon>
              <GanttIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        {
          id: 'risk',
          label: 'Risk policy',
          keywords: 'raid threshold monte carlo confidence appetite',
          icon: (
            <NavIcon>
              <RiskIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
      ],
    },
    {
      label: 'Configuration',
      items: [
        {
          id: 'attachments',
          label: 'Attachments',
          keywords: 'files uploads storage size limit',
          icon: (
            <NavIcon>
              <ExternalLinkIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        {
          id: 'integrations',
          label: 'Integrations',
          keywords: 'jira gitlab connect external source',
          icon: (
            <NavIcon>
              <SettingsIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
      ],
    },
    {
      label: 'Danger',
      items: [
        {
          id: 'lifecycle',
          label: 'Archive / Close',
          keywords: 'archive close delete complete status',
          icon: (
            <NavIcon>
              <WarningIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
      ],
    },
  ];

  return (
    <SettingsShell
      scope="program"
      scopeLinks={[
        {
          scope: 'workspace',
          label: 'Workspace',
          to: isWorkspaceAdmin === false ? null : '/settings',
          disabledReason: 'Requires workspace admin',
        },
        { scope: 'program', label: 'Program', to: `/programs/${programId}/settings` },
        {
          scope: 'project',
          label: 'Project',
          to: projectTarget ? `/projects/${projectTarget}/settings` : null,
          disabledReason: 'Scoped settings appear once you create a project',
        },
      ]}
      contextName={program?.name ?? 'Program settings'}
      contextHealth={programHealthDot(program?.health)}
      contextOptions={contextOptions}
      contextActiveId={programId}
      navGroups={navGroups}
      exitTo={`/programs/${programId}`}
      exitLabel="Overview"
    >
      <SettingsSection id="general">
        <ProgramGeneralPage />
      </SettingsSection>
      <SettingsSection id="projects">
        <ProgramProjectsPage />
      </SettingsSection>
      <SettingsSection id="access">
        <ProgramAccessPage />
      </SettingsSection>
      <SettingsSection id="stakeholders">
        <ProgramStakeholdersPage />
      </SettingsSection>
      <SettingsSection id="rollup">
        <ProgramRollupPage />
      </SettingsSection>
      <SettingsSection id="cadence">
        <ProgramCadencePage />
      </SettingsSection>
      <SettingsSection id="calendar">
        <ProgramCalendarPage />
      </SettingsSection>
      <SettingsSection id="risk">
        <ProgramRiskPolicyPage />
      </SettingsSection>
      <SettingsSection id="attachments">
        <ProgramAttachmentsPage />
      </SettingsSection>
      <SettingsSection id="integrations">
        <ProgramIntegrationsPage />
      </SettingsSection>
      <SettingsSection id="lifecycle">
        <ProgramArchivePage />
      </SettingsSection>
    </SettingsShell>
  );
}
