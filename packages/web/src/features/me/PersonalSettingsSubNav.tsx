/**
 * PersonalSettingsSubNav — shared in-page secondary nav across the four flat
 * /me/settings/* pages (#2023).
 *
 * Previously this nav lived inline in MyGeneralPreferencesPage and listed only
 * three of the four pages, and the other three pages rendered no subnav at all —
 * so once you left General there was no in-page way back or across. This single
 * component, rendered in every personal-settings header, gives all four pages the
 * same complete, consistent cross-navigation. Keep its entry list in sync with
 * UserMenu's Personal group.
 */
import { NavLink } from 'react-router';

interface Entry {
  to: string;
  label: string;
}

const ENTRIES: readonly Entry[] = [
  { to: '/me/settings/general', label: 'General' },
  { to: '/me/settings/notifications', label: 'Notifications' },
  { to: '/me/settings/connected-accounts', label: 'Connected accounts' },
  { to: '/me/settings/api-tokens', label: 'Personal access tokens' },
];

function linkClass({ isActive }: { isActive: boolean }) {
  return [
    'text-sm rounded-control px-1 -mx-1',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
    isActive
      ? 'font-medium text-neutral-text-primary'
      : 'text-neutral-text-secondary hover:text-neutral-text-primary',
  ].join(' ');
}

export function PersonalSettingsSubNav() {
  return (
    <nav
      aria-label="Personal settings sections"
      className="flex flex-wrap items-center gap-x-4 gap-y-1"
    >
      {ENTRIES.map((entry, i) => (
        <span key={entry.to} className="flex items-center gap-x-4">
          {i > 0 && (
            <span aria-hidden="true" className="text-neutral-text-disabled">
              ·
            </span>
          )}
          <NavLink to={entry.to} className={linkClass} end>
            {entry.label}
          </NavLink>
        </span>
      ))}
    </nav>
  );
}
