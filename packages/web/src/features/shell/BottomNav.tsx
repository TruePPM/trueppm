import { NavLink } from 'react-router';

// Bottom navigation rail — shown at < md (768px) in place of view tabs in the top bar
const NAV_ITEMS = [
  { to: '/gantt', label: 'Gantt', icon: '📊' },
  { to: '/board', label: 'Board', icon: '☰' },
  { to: '/list', label: 'List', icon: '📋' },
  { to: '/calendar', label: 'Calendar', icon: '📅' },
  { to: '/resources', label: 'Resources', icon: '👥' },
] as const;

export function BottomNav() {
  return (
    <nav
      aria-label="View"
      className="md:hidden flex items-stretch h-14 border-t border-neutral-border bg-neutral-surface"
    >
      {NAV_ITEMS.map(({ to, label, icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            [
              'flex flex-1 flex-col items-center justify-center gap-0.5 text-xs min-h-[44px]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset',
              isActive
                ? 'text-brand-primary font-medium'
                : 'text-neutral-text-secondary',
            ].join(' ')
          }
        >
          <span aria-hidden="true">{icon}</span>
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
