import { NavLink, useLocation } from 'react-router';
import {
  GanttIcon,
  BoardIcon,
  ListIcon,
  CalendarIcon,
  ResourcesIcon,
  SprintIcon,
  TodayIcon,
  SettingsIcon,
} from '@/components/Icons';
import { OverviewIcon } from '@/components/Icons';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { isTabVisibleForMethodology } from '@/features/shell/methodologyTabs';
import { ROLE_SCHEDULER } from '@/lib/roles';
import { iterationLabelForms } from '@/lib/iterationLabel';
import type { ComponentType } from 'react';

interface NavItem {
  view: string;
  label: string;
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: 'true' }>;
}

// Bottom navigation rail — shown at < md (768px) in place of view tabs in the top bar.
// Order mirrors ViewTabs: Overview first (orientation), then Today (the unified
// PM + Scrum-Master split view that leads the TRACK group, ADR-0180), then Board
// (execution). Today is the 0.3 headline view and must be reachable on mobile —
// a mobile-first product cannot strand its headline view behind the desktop tabs
// only (issue 1324). Today is visible for every methodology (methodologyTabs.ts).
// Risks omitted at mobile breakpoint — infrequent access; reachable via desktop tabs.
// Grid replaces the previous Table entry (issue #334, ADR-0053).
// Settings trails the row (gear, last) so mobile users reach project notification
// and access settings without the desktop tabs (issue 539). It routes to the
// project settings landing (rule 125) rather than a view under /projects/:id/.
const NAV_ITEMS: NavItem[] = [
  { view: 'overview', label: 'Overview', Icon: OverviewIcon },
  { view: 'today', label: 'Today', Icon: TodayIcon },
  { view: 'board', label: 'Board', Icon: BoardIcon },
  { view: 'sprints', label: 'Sprints', Icon: SprintIcon },
  { view: 'schedule', label: 'Schedule', Icon: GanttIcon },
  { view: 'grid', label: 'Grid', Icon: ListIcon },
  { view: 'calendar', label: 'Calendar', Icon: CalendarIcon },
  { view: 'resources', label: 'Team', Icon: ResourcesIcon },
  { view: 'settings', label: 'Settings', Icon: SettingsIcon },
];

export function BottomNav() {
  const location = useLocation();
  const projectId = useProjectId();
  const { role } = useCurrentUserRole(projectId ?? undefined);
  const project = useProject(projectId);

  // Derive active view from the last path segment, matching ViewTabs logic (ADR-0030).
  const pathSegments = location.pathname.split('/');
  const currentView = pathSegments[pathSegments.length - 1] ?? 'overview';

  // Default to HYBRID (all tabs visible) until the project loads. Read the
  // server-resolved methodology (ADR-0107, issue 955) so the mobile nav mirrors
  // ViewTabs — the effective preset gates which tabs show, not the raw override.
  const methodology = project.data?.effective_methodology ?? 'HYBRID';

  // Sprints tab adopts the project's configured container label (ADR-0111, #862).
  const sprintsLabel = iterationLabelForms(project.data?.iteration_label).plural;

  // Settings is always visible (project config is not methodology- or role-gated;
  // individual sections gate their own writes). Every other tab follows the
  // methodology preset, and Team additionally requires Scheduler+ (issue 539).
  const visibleItems = NAV_ITEMS.filter(
    (t) =>
      t.view === 'settings' ||
      (isTabVisibleForMethodology(t.view, methodology) &&
        (t.view !== 'resources' || (role !== null && role >= ROLE_SCHEDULER))),
  );

  if (!projectId) return null;

  return (
    <nav
      aria-label="View"
      className="md:hidden flex items-stretch h-14 border-t border-chrome-border bg-chrome-surface"
    >
      {visibleItems.map(({ view, label, Icon }) => {
        // Settings targets the consolidated settings page base (the shell scroll-
        // spies to the first section on entry). Pointing at the base rather than
        // …/settings/general keeps NavLink's own active match aligned with the
        // settled URL, so aria-current resolves to "page" across every section.
        const isSettings = view === 'settings';
        const to = isSettings
          ? `/projects/${projectId}/settings`
          : `/projects/${projectId}/${view}`;
        const isActive = isSettings
          ? location.pathname.includes(`/projects/${projectId}/settings`)
          : currentView === view;
        return (
          <NavLink
            key={view}
            to={to}
            replace
            className={[
              'flex flex-1 flex-col items-center justify-center gap-1 text-xs min-h-[44px]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset',
              isActive ? 'text-brand-primary font-medium' : 'text-neutral-text-secondary',
            ].join(' ')}
            aria-current={isActive ? 'page' : undefined}
          >
            <Icon
              className={isActive ? 'text-brand-primary' : 'text-neutral-text-disabled'}
              aria-hidden="true"
            />
            <span>{view === 'sprints' ? sprintsLabel : label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
