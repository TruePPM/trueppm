import { NavLink } from 'react-router';
import { GanttIcon, BoardIcon, ListIcon, CalendarIcon, ResourcesIcon } from '@/components/Icons';
import type { ComponentType } from 'react';

interface NavItem {
  to: string;
  label: string;
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: 'true' }>;
}

// Bottom navigation rail — shown at < md (768px) in place of view tabs in the top bar
const NAV_ITEMS: NavItem[] = [
  { to: '/gantt',     label: 'Gantt',     Icon: GanttIcon },
  { to: '/board',     label: 'Board',     Icon: BoardIcon },
  { to: '/list',      label: 'List',      Icon: ListIcon },
  { to: '/calendar',  label: 'Calendar',  Icon: CalendarIcon },
  { to: '/resources', label: 'Resources', Icon: ResourcesIcon },
];

export function BottomNav() {
  return (
    <nav
      aria-label="View"
      className="md:hidden flex items-stretch h-14 border-t border-neutral-border bg-neutral-surface"
    >
      {NAV_ITEMS.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            [
              'flex flex-1 flex-col items-center justify-center gap-1 text-xs min-h-[44px]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset',
              isActive ? 'text-brand-primary font-medium' : 'text-neutral-text-secondary',
            ].join(' ')
          }
        >
          {({ isActive }) => (
            <>
              <Icon
                className={isActive ? 'text-brand-primary' : 'text-neutral-text-disabled'}
                aria-hidden="true"
              />
              <span>{label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
