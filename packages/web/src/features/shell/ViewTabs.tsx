import { Link, useLocation } from 'react-router';
import { GanttIcon, WbsIcon, BoardIcon, ListIcon, CalendarIcon, ResourcesIcon, RiskIcon } from '@/components/Icons';
import type { ComponentType } from 'react';

interface Tab {
  view: string;
  label: string;
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: 'true' }>;
}

const TABS: Tab[] = [
  { view: 'gantt',     label: 'Gantt',     Icon: GanttIcon },
  { view: 'wbs',       label: 'WBS',       Icon: WbsIcon },
  { view: 'board',     label: 'Board',     Icon: BoardIcon },
  { view: 'list',      label: 'Table',     Icon: ListIcon },
  { view: 'calendar',  label: 'Calendar',  Icon: CalendarIcon },
  { view: 'resources', label: 'Resources', Icon: ResourcesIcon },
  { view: 'risk',      label: 'Risks',     Icon: RiskIcon },
];

export function ViewTabs() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  // Derive active view from ?view= param; default to 'gantt' when absent
  const currentView = params.get('view') ?? 'gantt';
  // Preserve ?project= when switching views so the active project context is not lost
  const projectId = params.get('project');

  return (
    <nav aria-label="View" className="hidden md:flex items-stretch h-full gap-0.5">
      {TABS.map(({ view, label, Icon }) => {
        const isActive = currentView === view;
        const href = projectId
          ? `/gantt?view=${view}&project=${encodeURIComponent(projectId)}`
          : `/gantt?view=${view}`;
        return (
          <Link
            key={view}
            to={href}
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
