import { Link, useLocation } from 'react-router';
import { GanttIcon, BoardIcon, ListIcon, CalendarIcon, ResourcesIcon, RiskIcon } from '@/components/Icons';
import type { ComponentType } from 'react';

interface Tab {
  view: string;
  label: string;
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: 'true' }>;
}

const TABS: Tab[] = [
  { view: 'gantt',     label: 'Gantt',     Icon: GanttIcon },
  { view: 'board',     label: 'Board',     Icon: BoardIcon },
  { view: 'list',      label: 'List',      Icon: ListIcon },
  { view: 'calendar',  label: 'Calendar',  Icon: CalendarIcon },
  { view: 'resources', label: 'Resources', Icon: ResourcesIcon },
  { view: 'risk',      label: 'Risks',     Icon: RiskIcon },
];

export function ViewTabs() {
  const location = useLocation();
  // Derive active view from ?view= param; default to 'gantt' when absent
  const currentView = new URLSearchParams(location.search).get('view') ?? 'gantt';

  return (
    <nav aria-label="View" className="hidden md:flex items-stretch h-full gap-0.5">
      {TABS.map(({ view, label, Icon }) => {
        const isActive = currentView === view;
        return (
          <Link
            key={view}
            to={`/gantt?view=${view}`}
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
          </Link>
        );
      })}
    </nav>
  );
}
