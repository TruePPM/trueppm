import { NavLink, useLocation } from 'react-router';
import { GanttIcon, WbsIcon, BoardIcon, ListIcon, CalendarIcon, ResourcesIcon, RiskIcon } from '@/components/Icons';
import { OverviewIcon } from '@/components/Icons';
import { useProjectId } from '@/hooks/useProjectId';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import type { ComponentType } from 'react';

interface Tab {
  view: string;
  label: string;
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: 'true' }>;
}

// Overview is first — it is the project landing/orientation surface (ADR-0030).
// Board is second — the execution surface for task planning and status.
const TABS: Tab[] = [
  { view: 'overview',   label: 'Overview',   Icon: OverviewIcon },
  { view: 'board',      label: 'Board',      Icon: BoardIcon },
  { view: 'schedule',   label: 'Schedule',   Icon: GanttIcon },
  { view: 'wbs',        label: 'WBS',        Icon: WbsIcon },
  { view: 'list',       label: 'Table',      Icon: ListIcon },
  { view: 'calendar',   label: 'Calendar',   Icon: CalendarIcon },
  { view: 'resources',  label: 'Team',       Icon: ResourcesIcon },
  { view: 'risk',       label: 'Risks',      Icon: RiskIcon },
];

/**
 * Top-bar tab strip for switching between project views (ADR-0030).
 *
 * Links are path-based (`/projects/:projectId/:view`) so each view has a
 * shareable URL.  Hidden when no project is selected (no projectId in params).
 */
// SCHEDULER role ordinal — same value as Role.SCHEDULER in the Django model.
const SCHEDULER_ROLE = 2;

export function ViewTabs() {
  const location = useLocation();
  const projectId = useProjectId();
  const { role } = useCurrentUserRole(projectId ?? undefined);

  if (!projectId) return null;

  // Derive active view from the last path segment.
  // e.g. /projects/abc/schedule → 'schedule'
  const pathSegments = location.pathname.split('/');
  const currentView = pathSegments[pathSegments.length - 1] ?? 'overview';

  // Pessimistic: hide Team tab while role is loading (null) or for role < SCHEDULER.
  // Direct URL access still works — TeamView renders PermissionDeniedNotice (rule 94).
  const visibleTabs = TABS.filter(
    (t) => t.view !== 'resources' || (role !== null && role >= SCHEDULER_ROLE),
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
            {label}
          </NavLink>
        );
      })}
    </nav>
  );
}
