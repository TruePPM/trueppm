import type { ReactNode } from 'react';
import type { HealthState } from '@/types';
import { useIsWorkspaceAdmin } from '@/hooks/useIsWorkspaceAdmin';
import { useCurrentUser } from '@/hooks/useCurrentUser';
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
import { ProjectCalendarsPage } from './project/ProjectCalendarsPage';
import { ProjectTeamPage } from './team/ProjectTeamPage';
import { ProjectSignalPrivacyPage } from './signalPrivacy/ProjectSignalPrivacyPage';
import {
  ProjectTeamWorkflowPage,
  TEAM_WORKFLOW_SECTION_ID,
  TEAM_WORKFLOW_SUBSECTION_IDS,
} from './project/ProjectTeamWorkflowPage';
import { ProjectIntegrationsPage } from './project/ProjectIntegrationsPage';
import { ProjectNotificationsPage } from './project/ProjectNotificationsPage';
import { ProjectAttachmentsPage } from './project/ProjectAttachmentsPage';
import { ProjectLabelsPage } from './project/ProjectLabelsPage';
import { ProjectVisibilityPage } from './project/ProjectVisibilityPage';
import { ProjectSharingPage } from './project/ProjectSharingPage';
import { ProjectAgentsPage } from './project/ProjectAgentsPage';
import { ProjectArchivePage } from './project/ProjectArchivePage';
import { ProjectTemplatesPage } from './project/ProjectTemplatesPage';
import { ProjectTemplateDivergencePage } from './project/ProjectTemplateDivergencePage';
import {
  ResourcesIcon,
  SprintIcon,
  SettingsIcon,
  WarningIcon,
  CalendarIcon,
  LockIcon,
  TagIcon,
  EyeOffIcon,
  PaperclipIcon,
  LayoutIcon,
  ShareIcon,
  PlugIcon,
  BellIcon,
  AgentIcon,
  CopyIcon,
  SeededUntouchedIcon,
} from '@/components/Icons';

function NavIcon({ children }: { children: ReactNode }) {
  return (
    <span className="w-4 h-4 inline-flex items-center justify-center shrink-0">{children}</span>
  );
}

/** Map a project's health state to the settings pill dot; unknown → neutral. */
function projectHealthDot(health?: HealthState): 'onTrack' | 'atRisk' | 'critical' | null {
  switch (health) {
    case 'on-track':
      return 'onTrack';
    case 'at-risk':
      return 'atRisk';
    case 'critical':
      return 'critical';
    default:
      return null; // unknown / undefined
  }
}

/**
 * Project settings — ONE scrolling page (ADR-0146, issue 1248). Every section is an
 * anchored `<SettingsSection>` region on a single mounted page; the rail
 * scroll-spies across them. Lives at /projects/:projectId/settings (sub-slugs
 * redirect to `#<slug>` via the router). The section components are reused
 * unchanged — this wrapper changes how they're mounted, not their internals.
 */
/**
 * The project settings rail (issue 2425).
 *
 * Lifted out of the component so the glyph-uniqueness invariant can be asserted
 * directly on the data. A repeated glyph inside one group is negative information:
 * it teaches the eye to stop scanning the column, which costs the rows whose icon
 * does mean something.
 *
 * @param showTeamTab methodology is AGILE or HYBRID, so the Team and Signal
 *   privacy rows apply; both are hidden for pre-methodology projects.
 * @param iterationSingular the project's own word for an iteration ("Sprint"),
 *   which titles the guardrails row.
 */
/**
 * The rail a project member who is **not** an admin anywhere sees (#2971).
 *
 * Project settings used to be admin-only end to end: `RequireAdminSettings`
 * bounced anyone whose `can_access_admin_settings` was false, on the reasonable
 * ADR-0122 grounds that a shell full of controls they cannot use reads as "not my
 * tool". That stops being reasonable the moment one of the sections is a *report
 * about them*. #2971's requirement is not "the endpoint answers a Viewer" — it is
 * that the team can open what is said about their project, and a page they are
 * redirected off is not open.
 *
 * So the page now admits them and shows exactly the sections they can act on,
 * which today is one. Kept as its own builder rather than a filter over the admin
 * rail so the set is a **declared allow-list**: a section becomes member-visible by
 * being named here, never by a predicate somewhere else changing shape.
 */
/**
 * Retired project-settings anchors → the section that absorbed them (#2969).
 *
 * Handed to `SettingsShell`, which rewrites a stale `…/settings#<slug>` hash to
 * the live one. The route half of the same promise lives in `router.tsx` as
 * `SectionRedirect` entries; both halves are needed because a hash is not part of
 * the path a route matches, so no router config can see one.
 *
 * Entries are never removed. The cost of keeping one is a map row; the cost of
 * dropping one is somebody's bookmark landing at the top of a long page with no
 * indication why.
 */
export const PROJECT_SETTINGS_ANCHOR_ALIASES: Record<string, string> = Object.fromEntries(
  TEAM_WORKFLOW_SUBSECTION_IDS.map((id) => [id, TEAM_WORKFLOW_SECTION_ID]),
);

export function buildProjectSettingsMemberNav(): SettingsNavGroup[] {
  return [
    {
      label: 'Your project',
      items: [
        {
          id: 'template-divergence',
          label: 'Template divergence',
          keywords: 'divergence digest template drift adapted unchanged reported governance',
          icon: (
            <NavIcon>
              <SeededUntouchedIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
      ],
    },
  ];
}

export function buildProjectSettingsNav({
  showTeamTab,
  iterationSingular,
}: {
  showTeamTab: boolean;
  iterationSingular: string;
}): SettingsNavGroup[] {
  return [
    {
      label: 'Setup',
      items: [
        {
          id: 'general',
          label: 'General',
          keywords: 'name description code project',
          icon: (
            <NavIcon>
              <SettingsIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        {
          id: 'access',
          label: 'Access',
          keywords: 'members permissions roles visibility rbac',
          icon: (
            <NavIcon>
              <LockIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        {
          // The three agile-configuration anchors collapsed into one row (#2969).
          // `keywords` carries every term the retired rows answered to — a rail
          // search for "guardrails", "statuses" or "waterfall" must still land
          // somewhere, and this row is now the only place any of them lives.
          id: TEAM_WORKFLOW_SECTION_ID,
          label: 'How this team works',
          keywords: `methodology agile scrum kanban waterfall hybrid workflow fields phases statuses board columns lanes wip limits custom fields cadence ${iterationSingular} guardrails policy`,
          icon: (
            <NavIcon>
              <SprintIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        {
          id: 'templates',
          label: 'Templates',
          keywords: 'template publish reuse shape skeleton starter',
          icon: (
            <NavIcon>
              <CopyIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        {
          // Its own row rather than a block folded into Templates (#2971). The
          // requirement is that the team can *find* what is reported about them;
          // a rail row with its own keywords and its own `#template-divergence`
          // anchor is findable, and a paragraph below a publish form is not.
          id: 'template-divergence',
          label: 'Template divergence',
          keywords: 'divergence digest template drift adapted unchanged reported governance',
          icon: (
            <NavIcon>
              <SeededUntouchedIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        ...(showTeamTab
          ? [
              {
                id: 'team',
                label: 'Team',
                keywords: 'members capacity roster assignees',
                icon: (
                  <NavIcon>
                    <ResourcesIcon aria-hidden="true" />
                  </NavIcon>
                ),
              },
            ]
          : []),
      ],
    },
    {
      label: 'Configuration',
      items: [
        {
          id: 'labels',
          label: 'Labels',
          keywords: 'tags colors chips categorize',
          icon: (
            <NavIcon>
              <TagIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        {
          id: 'calendars',
          label: 'Working calendars',
          keywords: 'holidays working days hours timezone',
          icon: (
            <NavIcon>
              <CalendarIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        ...(showTeamTab
          ? [
              {
                id: 'signal-privacy',
                label: 'Signal privacy',
                keywords: 'anonymize retro sentiment confidential',
                icon: (
                  <NavIcon>
                    <EyeOffIcon aria-hidden="true" />
                  </NavIcon>
                ),
              },
            ]
          : []),
        {
          id: 'attachments',
          label: 'Attachments',
          keywords: 'files uploads storage size limit',
          icon: (
            <NavIcon>
              <PaperclipIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        {
          id: 'surfaces',
          label: 'Surfaces',
          keywords: 'views tabs overview board schedule wbs table',
          icon: (
            <NavIcon>
              <LayoutIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        {
          id: 'sharing',
          label: 'Sharing',
          keywords: 'public link share external guest',
          icon: (
            <NavIcon>
              <ShareIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        {
          id: 'agents',
          label: 'Agents',
          keywords: 'ai agent mcp llm assistant read access opt out consent privacy',
          icon: (
            <NavIcon>
              <AgentIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        {
          id: 'integrations',
          label: 'Integrations',
          keywords: 'jira gitlab connect external source',
          icon: (
            <NavIcon>
              <PlugIcon aria-hidden="true" />
            </NavIcon>
          ),
        },
        {
          id: 'notifications',
          label: 'Notifications',
          keywords: 'email alerts mentions digest',
          icon: (
            <NavIcon>
              <BellIcon aria-hidden="true" />
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
          label: 'Lifecycle',
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
}

export function ProjectSettingsPage() {
  const projectId = useProjectId();
  const { data: project } = useProject(projectId);
  const { data: programs } = usePrograms();
  const { data: projects } = useProjects();
  // The Workspace scope tab links to `/settings`, which RequireWorkspaceAdmin
  // bounces a non-workspace-admin away from (#2012). Disable the tab (rather than
  // render a dead link) when the user is positively not a workspace admin.
  const isWorkspaceAdmin = useIsWorkspaceAdmin();
  const { user } = useCurrentUser();

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

  // #2971: a member who is admin nowhere reaches this page (the route no longer
  // bounces them) and gets the reduced rail — today, the divergence digest alone.
  // Strict `=== false`, matching every other consumer of this flag: an absent or
  // still-loading signal renders the full rail, so an admin never sees a flash of
  // the one-row view. The server is still the thing that refuses their writes.
  const memberView = user?.can_access_admin_settings === false;

  const navGroups: SettingsNavGroup[] = memberView
    ? buildProjectSettingsMemberNav()
    : buildProjectSettingsNav({ showTeamTab, iterationSingular });

  if (memberView) {
    return (
      <SettingsShell
        scope="project"
        scopeLinks={[
          {
            scope: 'workspace',
            label: 'Workspace',
            to: null,
            disabledReason: 'Requires workspace admin',
          },
          {
            scope: 'program',
            label: 'Program',
            to: null,
            disabledReason: 'Requires program admin',
          },
          { scope: 'project', label: 'Project', to: `/projects/${projectId}/settings` },
        ]}
        contextName={project?.name ?? 'Project settings'}
        contextHealth={projectHealthDot(activeProjectHealth)}
        contextOptions={contextOptions}
        contextActiveId={projectId}
        navGroups={navGroups}
        anchorAliases={PROJECT_SETTINGS_ANCHOR_ALIASES}
        exitTo={`/projects/${projectId}/overview`}
        exitLabel="Overview"
      >
        <SettingsSection id="template-divergence">
          <ProjectTemplateDivergencePage />
        </SettingsSection>
      </SettingsShell>
    );
  }

  return (
    <SettingsShell
      scope="project"
      scopeLinks={[
        {
          scope: 'workspace',
          label: 'Workspace',
          to: isWorkspaceAdmin === false ? null : '/settings',
          disabledReason: 'Requires workspace admin',
        },
        {
          scope: 'program',
          label: 'Program',
          to: programTarget ? `/programs/${programTarget}/settings` : null,
          disabledReason: 'Scoped settings appear once you create a program',
        },
        { scope: 'project', label: 'Project', to: `/projects/${projectId}/settings` },
      ]}
      contextName={project?.name ?? 'Project settings'}
      contextHealth={projectHealthDot(activeProjectHealth)}
      contextOptions={contextOptions}
      contextActiveId={projectId}
      navGroups={navGroups}
      anchorAliases={PROJECT_SETTINGS_ANCHOR_ALIASES}
      exitTo={`/projects/${projectId}/overview`}
      exitLabel="Overview"
    >
      <SettingsSection id="general">
        <ProjectGeneralPage />
      </SettingsSection>
      <SettingsSection id="access">
        <ProjectAccessPage />
      </SettingsSection>
      <SettingsSection id={TEAM_WORKFLOW_SECTION_ID}>
        <ProjectTeamWorkflowPage />
      </SettingsSection>

      {/* Beside Methodology on purpose: a template *is* a methodology decision
          made concrete, and the publish act belongs where the evidence is —
          in the project whose shape is being claimed as reusable (#2909). */}
      <SettingsSection id="templates">
        <ProjectTemplatesPage />
      </SettingsSection>

      {/* Immediately after Templates, and unconditional — no role gate, no
          methodology gate. This is the section a team reads to see what is said
          about them, so anything that could hide it from a Viewer would recreate
          the asymmetry #2971 exists to forbid. */}
      <SettingsSection id="template-divergence">
        <ProjectTemplateDivergencePage />
      </SettingsSection>
      {showTeamTab && (
        <SettingsSection id="team">
          <ProjectTeamPage />
        </SettingsSection>
      )}
      <SettingsSection id="labels">
        <ProjectLabelsPage />
      </SettingsSection>
      <SettingsSection id="calendars">
        <ProjectCalendarsPage />
      </SettingsSection>
      {showTeamTab && (
        <SettingsSection id="signal-privacy">
          <ProjectSignalPrivacyPage />
        </SettingsSection>
      )}
      <SettingsSection id="agents">
        <ProjectAgentsPage />
      </SettingsSection>

      <SettingsSection id="attachments">
        <ProjectAttachmentsPage />
      </SettingsSection>
      <SettingsSection id="surfaces">
        <ProjectVisibilityPage />
      </SettingsSection>
      <SettingsSection id="sharing">
        <ProjectSharingPage />
      </SettingsSection>
      <SettingsSection id="integrations">
        <ProjectIntegrationsPage />
      </SettingsSection>
      <SettingsSection id="notifications">
        <ProjectNotificationsPage />
      </SettingsSection>
      <SettingsSection id="lifecycle">
        <ProjectArchivePage />
      </SettingsSection>
    </SettingsShell>
  );
}
