import { NavLink, useLocation, useMatch } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useGroupedProjectViews } from '@/features/shell/useGroupedProjectViews';
import { VIEW_TAB_META, type ViewIconType } from '@/features/shell/viewMeta';

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
 * v2 grouped project view bar (ADR-0128 §A, amended by ADR-0195 and ADR-0203). Replaces the
 * flat 11-tab strip with methodology-adaptive PLAN / DELIVER / TRACK / PEOPLE groups (Overview
 * leads standalone, Settings trails standalone), method-filtered via the ADR-0041 matrix.
 * The DELIVER group co-locates the sprint circuit (Backlog · Sprints · Board) on
 * AGILE/HYBRID; WATERFALL has no DELIVER group and keeps Board in TRACK. Route segments are
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
  const onSettingsRoute = useMatch('/projects/:projectId/settings/*');
  // The grouped composition is shared with the left-rail "This project" tier via
  // this one hook (issue 1642) — the bar and the rail can never drift because both
  // read the same methodology-filtered, hidden-views-aware, role-gated groups.
  const { groups, labelFor, standaloneLeading, standaloneTrailing } =
    useGroupedProjectViews(projectId);

  if (!projectId || onSettingsRoute) return null;

  // Derive active view from the path segment immediately after the projectId.
  const pathSegments = location.pathname.split('/');
  const projectIdIndex = pathSegments.indexOf(projectId ?? '');
  const currentView =
    (projectIdIndex >= 0 ? pathSegments[projectIdIndex + 1] : undefined) ?? 'overview';

  return (
    <nav aria-label="View" className="hidden md:flex items-stretch h-full">
      <Tab
        projectId={projectId}
        view={standaloneLeading}
        label={labelFor(standaloneLeading)}
        Icon={TAB_META[standaloneLeading].Icon}
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
        view={standaloneTrailing}
        label={labelFor(standaloneTrailing)}
        Icon={TAB_META[standaloneTrailing].Icon}
        currentView={currentView}
      />
    </nav>
  );
}
