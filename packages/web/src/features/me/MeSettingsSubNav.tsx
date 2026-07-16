import { NavLink } from 'react-router';

/**
 * Shared in-page secondary nav across the flat `/me/settings/*` pages.
 *
 * The personal-settings pages are separate routes with no left rail, so this
 * subnav is the only way to move between them. It must list ALL four pages and
 * render on ALL four — previously each page listed a different subset (or none),
 * stranding the user with no way back or across (#2023).
 */
const ME_SETTINGS_LINKS: Array<{ to: string; label: string }> = [
  { to: '/me/settings/general', label: 'General' },
  { to: '/me/settings/notifications', label: 'Notifications' },
  { to: '/me/settings/connected-accounts', label: 'Connected accounts' },
  { to: '/me/settings/api-tokens', label: 'API tokens' },
];

export function MeSettingsSubNav() {
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    [
      'text-sm rounded-control px-1 -mx-1',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
      isActive
        ? 'font-medium text-neutral-text-primary'
        : 'text-neutral-text-secondary hover:text-neutral-text-primary',
    ].join(' ');
  return (
    <nav aria-label="Personal settings sections" className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {ME_SETTINGS_LINKS.flatMap((link, i) => [
        ...(i > 0
          ? [
              <span key={`${link.to}-sep`} aria-hidden="true" className="text-neutral-text-disabled">
                ·
              </span>,
            ]
          : []),
        <NavLink key={link.to} to={link.to} className={linkClass} end>
          {link.label}
        </NavLink>,
      ])}
    </nav>
  );
}
