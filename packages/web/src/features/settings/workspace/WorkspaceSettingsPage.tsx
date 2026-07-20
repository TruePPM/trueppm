import { useProjects } from '@/hooks/useProjects';
import { usePrograms } from '@/hooks/usePrograms';
import { SettingsShell, SettingsSection } from '../SettingsShell';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { WorkspaceGeneralPage } from './WorkspaceGeneralPage';
import { WorkspaceMembersPage } from './WorkspaceMembersPage';
import { WorkspaceGroupsPage } from './WorkspaceGroupsPage';
import { WorkspaceRolesPage } from './WorkspaceRolesPage';
import { WorkspaceMethodologyPage } from './WorkspaceMethodologyPage';
import { WorkspaceSchedulePage } from './WorkspaceSchedulePage';
import { WorkspaceCalendarPage } from './WorkspaceCalendarPage';
import { WorkspaceProgramsPage } from './WorkspaceProgramsPage';
import { WorkspaceEmailPage } from './WorkspaceEmailPage';
import { WorkspaceSsoPage } from './WorkspaceSsoPage';
import { WorkspaceAttachmentsPage } from './WorkspaceAttachmentsPage';
import { WorkspaceDangerPage } from './WorkspaceDangerPage';
import { buildWorkspaceNavGroups } from './workspaceNav';

// Config sections live inline on the consolidated page (ADR-0146), so the rail is
// built in scroll-spy mode (`linked: false` → config items omit `to`). The nav is
// a single shared source of truth (`workspaceNav`) so the off-route Trash / System
// Health shells cannot drift out of sync (#2013).
const NAV_GROUPS = buildWorkspaceNavGroups({ linked: false });

/**
 * Workspace settings — ONE scrolling page (ADR-0146, issue 1248). Lives at /settings;
 * sub-slugs redirect to `#<slug>`. The System Health tools stay as separate
 * routes (their nav items carry a `to`); the form sections are inline anchored
 * `<SettingsSection>` regions and reuse the existing components unchanged.
 */
export function WorkspaceSettingsPage() {
  const { data: projects } = useProjects();
  const { data: programs } = usePrograms();
  const { data: ws } = useWorkspaceSettings();

  const firstProjectId = projects?.[0]?.id;
  const firstProgramId = programs?.[0]?.id;

  return (
    <SettingsShell
      scope="workspace"
      scopeLinks={[
        { scope: 'workspace', label: 'Workspace', to: '/settings' },
        // Not-yet case (rule 125): keep the segment disabled so the tri-scope model
        // still teaches, but with guiding, non-imperative copy — never a command the
        // user can't obey (#2251). Contrast the workspace-only tool pages, which
        // HIDE these segments because the scope can never apply there.
        { scope: 'program',   label: 'Program',   to: firstProgramId ? `/programs/${firstProgramId}/settings` : null, disabledReason: 'Scoped settings appear once you create a program' },
        { scope: 'project',   label: 'Project',   to: firstProjectId ? `/projects/${firstProjectId}/settings` : null, disabledReason: 'Scoped settings appear once you create a project' },
      ]}
      contextName={ws?.name ?? 'Workspace'}
      navGroups={NAV_GROUPS}
      exitTo="/"
      exitLabel="Home"
    >
      <SettingsSection id="general"><WorkspaceGeneralPage /></SettingsSection>
      <SettingsSection id="members"><WorkspaceMembersPage /></SettingsSection>
      <SettingsSection id="groups"><WorkspaceGroupsPage /></SettingsSection>
      <SettingsSection id="roles"><WorkspaceRolesPage /></SettingsSection>
      <SettingsSection id="sso"><WorkspaceSsoPage /></SettingsSection>
      <SettingsSection id="methodology"><WorkspaceMethodologyPage /></SettingsSection>
      <SettingsSection id="schedule"><WorkspaceSchedulePage /></SettingsSection>
      <SettingsSection id="calendar"><WorkspaceCalendarPage /></SettingsSection>
      <SettingsSection id="programs"><WorkspaceProgramsPage /></SettingsSection>
      <SettingsSection id="attachments"><WorkspaceAttachmentsPage /></SettingsSection>
      <SettingsSection id="email"><WorkspaceEmailPage /></SettingsSection>
      <SettingsSection id="danger"><WorkspaceDangerPage /></SettingsSection>
    </SettingsShell>
  );
}
