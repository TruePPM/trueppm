import type { ReactNode } from 'react';
import { useProjects } from '@/hooks/useProjects';
import { usePrograms } from '@/hooks/usePrograms';
import { SettingsShell, SettingsSection, type SettingsNavGroup } from '../SettingsShell';
import { WorkspaceGeneralPage } from './WorkspaceGeneralPage';
import { WorkspaceMembersPage } from './WorkspaceMembersPage';
import { WorkspaceGroupsPage } from './WorkspaceGroupsPage';
import { WorkspaceRolesPage } from './WorkspaceRolesPage';
import { WorkspaceMethodologyPage } from './WorkspaceMethodologyPage';
import { WorkspaceSchedulePage } from './WorkspaceSchedulePage';
import { WorkspaceProgramsPage } from './WorkspaceProgramsPage';
import { WorkspaceEmailPage } from './WorkspaceEmailPage';
import { WorkspaceAttachmentsPage } from './WorkspaceAttachmentsPage';
import { WorkspaceDangerPage } from './WorkspaceDangerPage';
import {
  OverviewIcon,
  ResourcesIcon,
  WbsIcon,
  SprintIcon,
  SettingsIcon,
  ExternalLinkIcon,
  WarningIcon,
  GanttIcon,
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

// Config sections live inline on the consolidated page (ADR-0146); their nav
// items omit `to` and scroll-spy. System Health items keep a `to` — they are
// separate multi-route operational tools (overview, dead-letters, retention),
// not dirty-form sections, so they navigate as before.
const NAV_GROUPS: SettingsNavGroup[] = [
  {
    label: 'Organization',
    items: [
      { id: 'general',     label: 'General',              icon: <NavIcon><OverviewIcon aria-hidden="true" /></NavIcon> },
      { id: 'members',     label: 'Members',              icon: <NavIcon><ResourcesIcon aria-hidden="true" /></NavIcon> },
      { id: 'groups',      label: 'Groups & teams',       icon: <NavIcon><WbsIcon aria-hidden="true" /></NavIcon> },
      { id: 'roles',       label: 'Roles & permissions',  icon: <NavIcon><SettingsIcon aria-hidden="true" /></NavIcon> },
    ],
  },
  {
    label: 'Delivery',
    items: [
      { id: 'methodology', label: 'Methodology defaults', icon: <NavIcon><SprintIcon aria-hidden="true" /></NavIcon> },
      { id: 'schedule',    label: 'Schedule',             icon: <NavIcon><GanttIcon aria-hidden="true" /></NavIcon> },
      { id: 'programs',    label: 'Programs',             icon: <NavIcon><WbsIcon aria-hidden="true" /></NavIcon> },
      { id: 'attachments', label: 'Attachments',          icon: <NavIcon><ExternalLinkIcon aria-hidden="true" /></NavIcon> },
      { id: 'email',       label: 'Email & SMTP',         icon: <NavIcon><SettingsIcon aria-hidden="true" /></NavIcon> },
    ],
  },
  // The "Connections" nav group (Integrations + Webhooks & API) is removed from
  // OSS per ADR-0076; the routes remain as redirect shims (see router.tsx) and
  // Enterprise re-injects this group via the slot registry.
  {
    label: 'System',
    items: [
      { id: 'health', label: 'System health', to: '/settings/health', icon: <NavIcon><ActivityNavIcon /></NavIcon> },
      { id: 'retention', label: 'Retention & purge', to: '/settings/health/retention', icon: <NavIcon><RetentionNavIcon /></NavIcon> },
      { id: 'trash', label: 'Trash', to: '/settings/trash', icon: <NavIcon><RetentionNavIcon /></NavIcon> },
    ],
  },
  {
    label: 'Danger',
    items: [
      { id: 'danger', label: 'Archive / Delete', icon: <NavIcon><WarningIcon aria-hidden="true" /></NavIcon> },
    ],
  },
];

/**
 * Workspace settings — ONE scrolling page (ADR-0146, issue 1248). Lives at /settings;
 * sub-slugs redirect to `#<slug>`. The System Health tools stay as separate
 * routes (their nav items carry a `to`); the form sections are inline anchored
 * `<SettingsSection>` regions and reuse the existing components unchanged.
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
        { scope: 'workspace', label: 'Workspace', to: '/settings' },
        { scope: 'program',   label: 'Program',   to: firstProgramId ? `/programs/${firstProgramId}/settings` : null, disabledReason: 'No programs yet' },
        { scope: 'project',   label: 'Project',   to: firstProjectId ? `/projects/${firstProjectId}/settings` : null, disabledReason: 'No projects yet' },
      ]}
      contextName="TrueScope Aerospace"
      navGroups={NAV_GROUPS}
      exitTo="/"
      exitLabel="Home"
    >
      <SettingsSection id="general"><WorkspaceGeneralPage /></SettingsSection>
      <SettingsSection id="members"><WorkspaceMembersPage /></SettingsSection>
      <SettingsSection id="groups"><WorkspaceGroupsPage /></SettingsSection>
      <SettingsSection id="roles"><WorkspaceRolesPage /></SettingsSection>
      <SettingsSection id="methodology"><WorkspaceMethodologyPage /></SettingsSection>
      <SettingsSection id="schedule"><WorkspaceSchedulePage /></SettingsSection>
      <SettingsSection id="programs"><WorkspaceProgramsPage /></SettingsSection>
      <SettingsSection id="attachments"><WorkspaceAttachmentsPage /></SettingsSection>
      <SettingsSection id="email"><WorkspaceEmailPage /></SettingsSection>
      <SettingsSection id="danger"><WorkspaceDangerPage /></SettingsSection>
    </SettingsShell>
  );
}
