import { NavLink, useLocation } from 'react-router';
import { GanttIcon, BoardIcon, ListIcon, CalendarIcon, ResourcesIcon, RiskIcon, SprintIcon, SettingsIcon, BarChartIcon, WbsIcon } from '@/components/Icons';
import { OverviewIcon } from '@/components/Icons';
import { useProjectId } from '@/hooks/useProjectId';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useProject } from '@/hooks/useProject';
import { isTabVisibleForMethodology } from '@/features/shell/methodologyTabs';
import { ROLE_SCHEDULER } from '@/lib/roles';
import { iterationLabelForms } from '@/lib/iterationLabel';
import type { ComponentType } from 'react';

interface Tab {
  view: string;
  label: string;
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: 'true' }>;
}

// Overview is first — it is the project landing/orientation surface (ADR-0030).
// Board is second — the execution surface for task planning and status.
// Backlog is third — the PO grooming surface that feeds Sprints (#1096); it routes
// to the existing /product-backlog page and is methodology-gated to Agile/Hybrid.
// Sprints is fourth — between Backlog and Schedule, paired with execution surfaces (ADR-0041).
// Grid replaces the previous WBS + Table entries (issue #334, ADR-0053). Hierarchy
// is now a display mode inside Grid, not a separate top-level view.
const TABS: Tab[] = [
  { view: 'overview',        label: 'Overview',   Icon: OverviewIcon },
  { view: 'board',           label: 'Board',      Icon: BoardIcon },
  { view: 'product-backlog', label: 'Backlog',    Icon: WbsIcon },
  { view: 'sprints',         label: 'Sprints',    Icon: SprintIcon },
  { view: 'schedule',   label: 'Schedule',   Icon: GanttIcon },
  { view: 'grid',       label: 'Grid',       Icon: ListIcon },
  { view: 'calendar',   label: 'Calendar',   Icon: CalendarIcon },
  { view: 'resources',  label: 'Team',       Icon: ResourcesIcon },
  { view: 'risk',       label: 'Risks',      Icon: RiskIcon },
  { view: 'reports',   label: 'Reports',    Icon: BarChartIcon },
  // Settings tab — visible to all members (Viewer+); write controls are OWNER-gated
  // inside the page. Not in BottomNav (infrequent, admin access — same rationale as Risks).
  { view: 'settings',  label: 'Settings',   Icon: SettingsIcon },
];

/**
 * Top-bar tab strip for switching between project views (ADR-0030).
 *
 * Links are path-based (`/projects/:projectId/:view`) so each view has a
 * shareable URL.  Hidden when no project is selected (no projectId in params).
 */
// SCHEDULER role ordinal — same value as Role.SCHEDULER in the Django model.

export function ViewTabs() {
  const location = useLocation();
  const projectId = useProjectId();
  const { role } = useCurrentUserRole(projectId ?? undefined);
  const project = useProject(projectId);

  if (!projectId) return null;

  // Derive active view from the path segment immediately after the projectId.
  // e.g. /projects/abc/schedule → 'schedule'
  //      /projects/abc/settings/members → 'settings'
  const pathSegments = location.pathname.split('/');
  const projectIdIndex = pathSegments.indexOf(projectId ?? '');
  const currentView = (projectIdIndex >= 0 ? pathSegments[projectIdIndex + 1] : undefined) ?? 'overview';

  // Default to HYBRID (all tabs visible) until the project loads — preserves
  // pre-methodology behavior during the brief loading window.
  const methodology = project.data?.methodology ?? 'HYBRID';

  // The Sprints tab adopts the project's configured container label (ADR-0111, #862).
  const sprintsLabel = iterationLabelForms(project.data?.iteration_label).plural;

  // Pessimistic: hide Team tab while role is loading (null) or for role < SCHEDULER.
  // Direct URL access still works — TeamView renders PermissionDeniedNotice (rule 94).
  // Methodology preset filter (ADR-0041) layers on top of role gating.
  const visibleTabs = TABS.filter(
    (t) =>
      isTabVisibleForMethodology(t.view, methodology) &&
      (t.view !== 'resources' || (role !== null && role >= ROLE_SCHEDULER)),
  );

  return (
    <nav aria-label="View" className="hidden md:flex items-stretch h-full gap-0.5">
      {visibleTabs.map(({ view, label, Icon }) => {
        const isActive = currentView === view;
        return (
          <NavLink
            key={view}
            to={`/projects/${projectId}/${view}`}
            replace
            className={[
              'flex items-center gap-1.5 px-3 text-sm font-medium border-b-2 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
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
            {view === 'sprints' ? sprintsLabel : label}
          </NavLink>
        );
      })}
    </nav>
  );
}
