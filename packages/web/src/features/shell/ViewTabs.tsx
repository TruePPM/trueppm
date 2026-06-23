import { NavLink, useLocation, useMatch } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useProject } from '@/hooks/useProject';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import {
  groupedVisibleViewsForUser,
  STANDALONE_LEADING,
  STANDALONE_TRAILING,
} from '@/features/shell/methodologyTabs';
import { applyRoleContextLensOrder } from '@/features/shell/lensOrder';
import { VIEW_TAB_META, type ViewIconType } from '@/features/shell/viewMeta';
import { ROLE_SCHEDULER } from '@/lib/roles';
import type { Methodology } from '@/types';

type IconType = ViewIconType;

// Render metadata (label + icon per view key) is shared via `viewMeta.ts` so the
// bar, the Customize-views menu (ADR-0139), and the ⌘K palette never drift.
const TAB_META = VIEW_TAB_META;

// Mono group-header + workspace-label token (rule 36/101).
const GROUP_LABEL =
  'self-center px-2 text-xs font-semibold tracking-widest uppercase text-chrome-text-secondary select-none whitespace-nowrap';

function Divider() {
  return <span aria-hidden="true" className="self-center mx-1 h-5 w-px bg-chrome-border" />;
}

interface TabProps {
  projectId: string;
  view: string;
  label: string;
  Icon: IconType;
  currentView: string;
}

function Tab({ projectId, view, label, Icon, currentView }: TabProps) {
  const isActive = currentView === view;
  return (
    <NavLink
      to={`/projects/${projectId}/${view}`}
      replace
      className={[
        'flex items-center gap-1.5 px-3 text-sm font-medium border-b-2 transition-colors',
        // Inset ring (rule 174): these tabs live in the ShellNavScroller's
        // overflow-x-auto region, which clips an offset ring top/bottom (rule 137 precedent).
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary',
        isActive
          ? 'border-brand-primary text-brand-primary'
          : 'border-transparent text-neutral-text-secondary hover:text-neutral-text-primary',
      ].join(' ')}
      aria-current={isActive ? 'page' : undefined}
    >
      <Icon
        className={isActive ? 'text-brand-primary' : 'text-neutral-text-disabled'}
        aria-hidden="true"
      />
      {label}
    </NavLink>
  );
}

/**
 * v2 grouped project view bar (ADR-0128 §A). Replaces the flat 11-tab strip
 * with PLAN / TRACK / PEOPLE groups (Overview leads standalone, Settings trails
 * standalone), method-filtered via the ADR-0041 matrix. Route segments are
 * unchanged (rule 108): links are still `/projects/:id/:view`.
 *
 * Project-scoped: returns null off a project route (the `useProjectId()` null path,
 * which also covers My Work / Inbox / Portfolio / Program / workspace settings —
 * `ProgramTabs` owns program routes per ADR-0095) and on project settings routes
 * (the SettingsShell carries its own chrome — rule 123 / ADR-0128 §C).
 */
export function ViewTabs() {
  const location = useLocation();
  const projectId = useProjectId();
  const { role } = useCurrentUserRole(projectId ?? undefined);
  const { user } = useCurrentUser();
  const project = useProject(projectId);
  const iteration = useIterationLabel(projectId);
  const onSettingsRoute = useMatch('/projects/:projectId/settings/*');

  if (!projectId || onSettingsRoute) return null;

  // Derive active view from the path segment immediately after the projectId.
  const pathSegments = location.pathname.split('/');
  const projectIdIndex = pathSegments.indexOf(projectId ?? '');
  const currentView =
    (projectIdIndex >= 0 ? pathSegments[projectIdIndex + 1] : undefined) ?? 'overview';

  // Default to HYBRID (all tabs visible) until the project loads. Read the
  // SERVER-RESOLVED methodology (ADR-0107, issue 955): project ?? program ??
  // workspace, gated by the workspace override policy. Tab visibility follows the
  // effective preset, not the raw per-project override, so a workspace INHERIT
  // lock correctly hides the other methodology's chrome.
  const methodology = project.data?.effective_methodology ?? 'HYBRID';

  // Role gate (pessimistic): the Team view is hidden while role is loading (null)
  // or for role < SCHEDULER. Direct URL access still works (PermissionDeniedNotice).
  const roleAllows = (view: string) =>
    view !== 'resources' || (role !== null && role >= ROLE_SCHEDULER);

  // Per-view label: Sprints adopts the configured container label (ADR-0111/0116).
  const labelFor = (view: string) =>
    view === 'sprints' ? iteration.plural : (TAB_META[view]?.label ?? view);

  // Per-user nav visibility (ADR-0139): the personal hidden-set composes on top
  // of the methodology filter, then the role gate. `overview` leads standalone
  // (outside the hidden-set) so the bar can never be emptied.
  const hiddenViews = new Set(user?.hidden_views ?? []);
  // Role-context lens (issue 1263, ADR-0162): promote the active lens's priority views
  // to the front of their group. Composes AFTER the methodology / hidden-views /
  // role filters — it only re-orders already-permitted views, never reveals one.
  // `unified` (default while `user` is loading) is the identity → no flash.
  const groups = applyRoleContextLensOrder(
    groupedVisibleViewsForUser(methodology, hiddenViews)
      .map((g) => ({ ...g, visibleViews: g.visibleViews.filter(roleAllows) }))
      .filter((g) => g.visibleViews.length > 0),
    user?.role_context ?? 'unified',
  );

  return (
    <nav aria-label="View" className="hidden md:flex items-stretch h-full">
      <Tab
        projectId={projectId}
        view={STANDALONE_LEADING}
        label={labelFor(STANDALONE_LEADING)}
        Icon={TAB_META[STANDALONE_LEADING].Icon}
        currentView={currentView}
      />

      {groups.map((group) => (
        <div
          key={group.id}
          role="group"
          aria-label={`${group.label} views`}
          className="flex items-stretch h-full"
        >
          <Divider />
          <span aria-hidden="true" className={GROUP_LABEL}>
            {group.id}
          </span>
          {group.visibleViews.map((view) => (
            <Tab
              key={view}
              projectId={projectId}
              view={view}
              label={labelFor(view)}
              Icon={TAB_META[view].Icon}
              currentView={currentView}
            />
          ))}
        </div>
      ))}

      <Divider />
      <Tab
        projectId={projectId}
        view={STANDALONE_TRAILING}
        label={labelFor(STANDALONE_TRAILING)}
        Icon={TAB_META[STANDALONE_TRAILING].Icon}
        currentView={currentView}
      />
    </nav>
  );
}

const METHOD_LABEL: Record<Methodology, string> = {
  AGILE: 'Agile',
  WATERFALL: 'Waterfall',
  HYBRID: 'Hybrid',
};

/**
 * Right-aligned "{METHOD} Workspace" tag for the v2 view row (ADR-0128 §A). Lives
 * at the left edge of the TopBar's right cluster (just before the health cluster)
 * so it is reliably right-aligned without making the tab nav grow. `hidden xl:inline`
 * — it is the first thing to drop as width tightens. Self-gates exactly like
 * `ViewTabs` (off-project / settings routes).
 */
export function MethodWorkspaceLabel() {
  const projectId = useProjectId();
  const { data: project } = useProject(projectId);
  const onSettingsRoute = useMatch('/projects/:projectId/settings/*');

  if (!projectId || onSettingsRoute) return null;

  // Show the server-resolved preset (ADR-0107, issue 955), matching the tab gate.
  const methodology = project?.effective_methodology ?? 'HYBRID';
  return (
    <span className={`${GROUP_LABEL} hidden xl:inline`}>{METHOD_LABEL[methodology]} Workspace</span>
  );
}
