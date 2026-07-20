import { Outlet } from 'react-router';
import { SettingsShell } from '../SettingsShell';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { buildWorkspaceNavGroups } from './workspaceNav';

/**
 * Shell for the workspace System Health tools (ADR-0146, issue 1248).
 *
 * System Health is a multi-route operational area (overview, dead-letter
 * inspector, retention & purge) — not a dirty-form section — so it stays on its
 * own routes rather than joining the consolidated single-page settings (issue 1248).
 * This wrapper renders the same left rail so the chrome is consistent, with an
 * `<Outlet/>` for the active tool. The rail is built off-route (`linked: true`): the
 * config sections deep-link back to the consolidated page at their anchor; the
 * System Health items link between the tools.
 */

// Fed from the shared `workspaceNav` builder so the rail stays in sync with the
// consolidated page and cannot drift (#2013).
const NAV_GROUPS = buildWorkspaceNavGroups({ linked: true });

export function WorkspaceSystemHealthShell() {
  const { data: ws } = useWorkspaceSettings();
  return (
    <SettingsShell
      scope="workspace"
      scopeLinks={[
        { scope: 'workspace', label: 'Workspace', to: '/settings' },
        // System Health is inherently workspace-only — no program/project-scoped
        // health tool exists — so hide those segments rather than showing them
        // permanently disabled with an imperative the user can't act on (#2251).
        { scope: 'program', label: 'Program', to: null, hidden: true },
        { scope: 'project', label: 'Project', to: null, hidden: true },
      ]}
      contextName={ws?.name ?? 'Workspace'}
      navGroups={NAV_GROUPS}
      exitTo="/"
      exitLabel="Home"
    >
      <Outlet />
    </SettingsShell>
  );
}
