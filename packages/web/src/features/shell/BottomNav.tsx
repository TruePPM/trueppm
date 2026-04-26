import { Link, useLocation } from 'react-router';
import { GanttIcon, BoardIcon, ListIcon, CalendarIcon, ResourcesIcon, RiskIcon } from '@/components/Icons';
import type { ComponentType } from 'react';

interface NavItem {
  view: string;
  label: string;
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: 'true' }>;
}

// Bottom navigation rail — shown at < md (768px) in place of view tabs in the top bar.
// Order mirrors ViewTabs: Board first (planning surface), Schedule second (derived view).
const NAV_ITEMS: NavItem[] = [
  { view: 'board',     label: 'Board',    Icon: BoardIcon },
  { view: 'gantt',     label: 'Schedule', Icon: GanttIcon },
  { view: 'list',      label: 'Table',    Icon: ListIcon },
  { view: 'calendar',  label: 'Calendar', Icon: CalendarIcon },
  { view: 'resources', label: 'Team',     Icon: ResourcesIcon },
  { view: 'risk',      label: 'Risks',    Icon: RiskIcon },
];

export function BottomNav() {
  const location = useLocation();
  // Derive active view from ?view= param; default to 'gantt' when absent
  const currentView = new URLSearchParams(location.search).get('view') ?? 'gantt';

  return (
    <nav
      aria-label="View"
      className="md:hidden flex items-stretch h-14 border-t border-neutral-border bg-neutral-surface"
    >
      {NAV_ITEMS.map(({ view, label, Icon }) => {
        const isActive = currentView === view;
        return (
          <Link
            key={view}
            to={`/gantt?view=${view}`}
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
          </Link>
        );
      })}
    </nav>
  );
}
