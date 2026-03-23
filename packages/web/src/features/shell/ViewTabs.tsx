import { NavLink } from 'react-router';
import { GanttIcon, BoardIcon, ListIcon, CalendarIcon, ResourcesIcon } from '@/components/Icons';
import type { ComponentType } from 'react';

interface Tab {
  to: string;
  label: string;
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: 'true' }>;
}

const TABS: Tab[] = [
  { to: '/gantt',     label: 'Gantt',     Icon: GanttIcon },
  { to: '/board',     label: 'Board',     Icon: BoardIcon },
  { to: '/list',      label: 'List',      Icon: ListIcon },
  { to: '/calendar',  label: 'Calendar',  Icon: CalendarIcon },
  { to: '/resources', label: 'Resources', Icon: ResourcesIcon },
];

export function ViewTabs() {
  return (
    <nav aria-label="View" className="hidden md:flex items-stretch h-full gap-0.5">
      {TABS.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            [
              'flex items-center gap-1.5 px-3 text-sm font-medium border-b-2 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
              isActive
                ? 'border-brand-primary text-brand-primary'
                : 'border-transparent text-neutral-text-secondary hover:text-neutral-text-primary',
            ].join(' ')
          }
        >
          {({ isActive }) => (
            <>
              <Icon
                className={isActive ? 'text-brand-primary' : 'text-neutral-text-disabled'}
                aria-hidden="true"
              />
              {label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
