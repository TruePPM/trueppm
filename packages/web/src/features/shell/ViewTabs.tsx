import { NavLink, useLocation } from 'react-router';
import { GanttIcon, WbsIcon, BoardIcon, ListIcon, CalendarIcon, ResourcesIcon, RiskIcon } from '@/components/Icons';
import { OverviewIcon } from '@/components/Icons';
import { useProjectId } from '@/hooks/useProjectId';
import type { ComponentType } from 'react';

interface Tab {
  view: string;
  label: string;
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: 'true' }>;
}

// Board is first — it is the canonical planning surface (card = task, swimlane = phase).
// Schedule (Gantt) is second — a derived projection of the Board. Tab order encodes
// the order of planning: plan the work, then schedule it. See issues #177/#178.
const TABS: Tab[] = [
  { view: 'board',      label: 'Board',      Icon: BoardIcon },
  { view: 'gantt',      label: 'Schedule',   Icon: GanttIcon },
  { view: 'wbs',        label: 'WBS',        Icon: WbsIcon },
  { view: 'list',       label: 'Table',      Icon: ListIcon },
  { view: 'calendar',   label: 'Calendar',   Icon: CalendarIcon },
  { view: 'overview',   label: 'Overview',   Icon: OverviewIcon },
  { view: 'resources',  label: 'Team',       Icon: ResourcesIcon },
  { view: 'risk',       label: 'Risks',      Icon: RiskIcon },
];

/**
 * Top-bar tab strip for switching between project views (ADR-0030).
 *
 * Links are path-based (`/projects/:projectId/:view`) so each view has a
 * shareable URL.  Hidden when no project is selected (no projectId in params).
 */
export function ViewTabs() {
  const location = useLocation();
  const projectId = useProjectId();

  if (!projectId) return null;

  // Derive active view from the last path segment.
  // e.g. /projects/abc/gantt → 'gantt'
  const pathSegments = location.pathname.split('/');
  const currentView = pathSegments[pathSegments.length - 1] ?? 'overview';

  return (
    <nav aria-label="View" className="hidden md:flex items-stretch h-full gap-0.5">
      {TABS.map(({ view, label, Icon }) => {
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
