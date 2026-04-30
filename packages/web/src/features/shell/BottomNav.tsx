import { NavLink, useLocation } from 'react-router';
import { GanttIcon, BoardIcon, ListIcon, CalendarIcon, ResourcesIcon } from '@/components/Icons';
import { OverviewIcon } from '@/components/Icons';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useProjectId } from '@/hooks/useProjectId';
import type { ComponentType } from 'react';

interface NavItem {
  view: string;
  label: string;
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: 'true' }>;
}

// Bottom navigation rail — shown at < md (768px) in place of view tabs in the top bar.
// Order mirrors ViewTabs: Overview first (orientation), Board second (execution).
// Risks and WBS omitted at mobile breakpoint — infrequent access; reachable via desktop tabs.
const NAV_ITEMS: NavItem[] = [
  { view: 'overview',  label: 'Overview', Icon: OverviewIcon },
  { view: 'board',     label: 'Board',    Icon: BoardIcon },
  { view: 'schedule',  label: 'Schedule', Icon: GanttIcon },
  { view: 'list',      label: 'Table',    Icon: ListIcon },
  { view: 'calendar',  label: 'Calendar', Icon: CalendarIcon },
  { view: 'resources', label: 'Team',     Icon: ResourcesIcon },
];

const SCHEDULER_ROLE = 2;

export function BottomNav() {
  const location = useLocation();
  const projectId = useProjectId();
  const { role } = useCurrentUserRole(projectId ?? undefined);

  // Derive active view from the last path segment, matching ViewTabs logic (ADR-0030).
  const pathSegments = location.pathname.split('/');
  const currentView = pathSegments[pathSegments.length - 1] ?? 'overview';

  const visibleItems = NAV_ITEMS.filter(
    (t) => t.view !== 'resources' || (role !== null && role >= SCHEDULER_ROLE),
  );

  if (!projectId) return null;

  return (
    <nav
      aria-label="View"
      className="md:hidden flex items-stretch h-14 border-t border-chrome-border bg-chrome-surface"
    >
      {visibleItems.map(({ view, label, Icon }) => {
        const isActive = currentView === view;
        return (
          <NavLink
            key={view}
            to={`/projects/${projectId}/${view}`}
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
            <span>{label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
