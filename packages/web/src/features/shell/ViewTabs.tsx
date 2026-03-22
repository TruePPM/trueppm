import { NavLink } from 'react-router';

const TABS = [
  { to: '/gantt', label: 'Gantt' },
  { to: '/board', label: 'Board' },
  { to: '/list', label: 'List' },
  { to: '/calendar', label: 'Calendar' },
  { to: '/resources', label: 'Resources' },
] as const;

export function ViewTabs() {
  return (
    <nav aria-label="View" className="hidden md:flex items-stretch h-full gap-1">
      {TABS.map(({ to, label }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            [
              'flex items-center px-3 text-sm font-medium border-b-2 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
              isActive
                ? 'border-brand-primary text-brand-primary'
                : 'border-transparent text-neutral-text-secondary hover:text-neutral-text-primary',
            ].join(' ')
          }
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
