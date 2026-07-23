import type { ReactNode } from 'react';
import type { HealthState } from '@/types';
import { useIsWorkspaceAdmin } from '@/hooks/useIsWorkspaceAdmin';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { iterationLabelForms } from '@/lib/iterationLabel';
import { usePrograms } from '@/hooks/usePrograms';
import { useProjects } from '@/hooks/useProjects';
import {
  SettingsShell,
  SettingsSection,
  type SettingsContextOption,
  type SettingsNavGroup,
} from './SettingsShell';
import { ProjectGeneralPage } from './project/ProjectGeneralPage';
import { ProjectAccessPage } from './project/ProjectAccessPage';
import { ProjectMethodologyPage } from './project/ProjectMethodologyPage';
import { ProjectCalendarsPage } from './project/ProjectCalendarsPage';
import { ProjectTeamPage } from './team/ProjectTeamPage';
import { ProjectSignalPrivacyPage } from './signalPrivacy/ProjectSignalPrivacyPage';
import { ProjectWorkflowPage } from './project/ProjectWorkflowPage';
import { ProjectGuardrailsPage } from './project/ProjectGuardrailsPage';
import { ProjectIntegrationsPage } from './project/ProjectIntegrationsPage';
import { ProjectNotificationsPage } from './project/ProjectNotificationsPage';
import { ProjectAttachmentsPage } from './project/ProjectAttachmentsPage';
import { ProjectLabelsPage } from './project/ProjectLabelsPage';
import { ProjectVisibilityPage } from './project/ProjectVisibilityPage';
import { ProjectSharingPage } from './project/ProjectSharingPage';
import { ProjectArchivePage } from './project/ProjectArchivePage';
import {
  OverviewIcon,
  ResourcesIcon,
  SprintIcon,
  WbsIcon,
  SettingsIcon,
  ExternalLinkIcon,
  WarningIcon,
  CalendarIcon,
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
 * Project settings — ONE scrolling page (ADR-0146, issue 1248). Every section is an
 * anchored `<SettingsSection>` region on a single mounted page; the rail
 * scroll-spies across them. Lives at /projects/:projectId/settings (sub-slugs
 * redirect to `#<slug>` via the router). The section components are reused
 * unchanged — this wrapper changes how they're mounted, not their internals.
 */
export function ProjectSettingsPage() {
  const projectId = useProjectId();
  const { data: project } = useProject(projectId);
  const { data: programs } = usePrograms();
  const { data: projects } = useProjects();
  // The Workspace scope tab links to `/settings`, which RequireWorkspaceAdmin
  // bounces a non-workspace-admin away from (#2012). Disable the tab (rather than
  // render a dead link) when the user is positively not a workspace admin.
  const isWorkspaceAdmin = useIsWorkspaceAdmin();

  if (!projectId) return null;

  // Program scope lands on THIS project's parent program (issue 776) — not an arbitrary
  // first program. Standalone projects fall through to the first program.
  const parentProgramId = projects?.find((p) => p.id === projectId)?.programId ?? null;
  const programTarget = parentProgramId ?? programs?.[0]?.id ?? null;

  // Sibling-project switcher options (issue 776).
  const contextOptions: SettingsContextOption[] = (projects ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    health: projectHealthDot(p.healthState),
    to: `/projects/${p.id}/settings`,
  }));
  const activeProjectHealth = projects?.find((p) => p.id === projectId)?.healthState;

  // Team + Signal-privacy sections are methodology-gated (ADR-0078/ADR-0104):
  // agile/hybrid only. Waterfall projects never see them. HYBRID is the default
  // for pre-methodology rows.
  const showTeamTab = project?.methodology === 'AGILE' || project?.methodology === 'HYBRID';
  const iterationSingular = iterationLabelForms(project?.iteration_label).singular;

  const navGroups: SettingsNavGroup[] = [
    {
      label: 'Setup',
      items: [
        { id: 'general',     label: 'General',     keywords: 'name description code project', icon: <NavIcon><OverviewIcon aria-hidden="true" /></NavIcon> },
        { id: 'access',      label: 'Access',      keywords: 'members permissions roles visibility rbac', icon: <NavIcon><ResourcesIcon aria-hidden="true" /></NavIcon> },
        { id: 'methodology', label: 'Methodology', keywords: 'agile scrum kanban waterfall hybrid', icon: <NavIcon><SprintIcon aria-hidden="true" /></NavIcon> },
        ...(showTeamTab
          ? [{ id: 'team', label: 'Team', keywords: 'members capacity roster assignees', icon: <NavIcon><ResourcesIcon aria-hidden="true" /></NavIcon> }]
          : []),
      ],
    },
    {
      label: 'Configuration',
      items: [
        { id: 'workflow',   label: 'Workflow & fields',                keywords: 'statuses columns custom fields board states', icon: <NavIcon><WbsIcon aria-hidden="true" /></NavIcon> },
        { id: 'labels',     label: 'Labels',                           keywords: 'tags colors chips categorize', icon: <NavIcon><SettingsIcon aria-hidden="true" /></NavIcon> },
        { id: 'calendars',  label: 'Working calendars',                keywords: 'holidays working days hours timezone', icon: <NavIcon><CalendarIcon aria-hidden="true" /></NavIcon> },
        { id: 'guardrails', label: `${iterationSingular} guardrails`,  keywords: 'sprint iteration wip limits capacity policy', icon: <NavIcon><WarningIcon aria-hidden="true" /></NavIcon> },
        ...(showTeamTab
          ? [{ id: 'signal-privacy', label: 'Signal privacy', keywords: 'anonymize retro sentiment confidential', icon: <NavIcon><SettingsIcon aria-hidden="true" /></NavIcon> }]
          : []),
        { id: 'attachments', label: 'Attachments', keywords: 'files uploads storage size limit', icon: <NavIcon><ExternalLinkIcon aria-hidden="true" /></NavIcon> },
        { id: 'surfaces',    label: 'Surfaces',    keywords: 'views tabs overview board schedule wbs table', icon: <NavIcon><SettingsIcon aria-hidden="true" /></NavIcon> },
        { id: 'sharing',     label: 'Sharing',     keywords: 'public link share external guest', icon: <NavIcon><ExternalLinkIcon aria-hidden="true" /></NavIcon> },
        { id: 'integrations',  label: 'Integrations',  keywords: 'jira gitlab connect external source', icon: <NavIcon><SettingsIcon aria-hidden="true" /></NavIcon> },
        { id: 'notifications', label: 'Notifications', keywords: 'email alerts mentions digest', icon: <NavIcon><SettingsIcon aria-hidden="true" /></NavIcon> },
      ],
    },
    {
      label: 'Danger',
      items: [
        { id: 'lifecycle', label: 'Lifecycle', keywords: 'archive close delete complete status', icon: <NavIcon><WarningIcon aria-hidden="true" /></NavIcon> },
      ],
    },
  ];

  return (
    <SettingsShell
      scope="project"
      scopeLinks={[
        { scope: 'workspace', label: 'Workspace', to: isWorkspaceAdmin === false ? null : '/settings', disabledReason: 'Requires workspace admin' },
        { scope: 'program',   label: 'Program',   to: programTarget ? `/programs/${programTarget}/settings` : null, disabledReason: 'Scoped settings appear once you create a program' },
        { scope: 'project',   label: 'Project',   to: `/projects/${projectId}/settings` },
      ]}
      contextName={project?.name ?? 'Project settings'}
      contextHealth={projectHealthDot(activeProjectHealth)}
      contextOptions={contextOptions}
      contextActiveId={projectId}
      navGroups={navGroups}
      exitTo={`/projects/${projectId}/overview`}
      exitLabel="Overview"
    >
      <SettingsSection id="general"><ProjectGeneralPage /></SettingsSection>
      <SettingsSection id="access"><ProjectAccessPage /></SettingsSection>
      <SettingsSection id="methodology"><ProjectMethodologyPage /></SettingsSection>
      {showTeamTab && <SettingsSection id="team"><ProjectTeamPage /></SettingsSection>}
      <SettingsSection id="workflow"><ProjectWorkflowPage /></SettingsSection>
      <SettingsSection id="labels"><ProjectLabelsPage /></SettingsSection>
      <SettingsSection id="calendars"><ProjectCalendarsPage /></SettingsSection>
      <SettingsSection id="guardrails"><ProjectGuardrailsPage /></SettingsSection>
      {showTeamTab && (
        <SettingsSection id="signal-privacy"><ProjectSignalPrivacyPage /></SettingsSection>
      )}
      <SettingsSection id="attachments"><ProjectAttachmentsPage /></SettingsSection>
      <SettingsSection id="surfaces"><ProjectVisibilityPage /></SettingsSection>
      <SettingsSection id="sharing"><ProjectSharingPage /></SettingsSection>
      <SettingsSection id="integrations"><ProjectIntegrationsPage /></SettingsSection>
      <SettingsSection id="notifications"><ProjectNotificationsPage /></SettingsSection>
      <SettingsSection id="lifecycle"><ProjectArchivePage /></SettingsSection>
    </SettingsShell>
  );
}
