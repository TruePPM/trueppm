import { NavLink } from 'react-router';

/**
 * Shared in-page secondary nav across the flat `/me/settings/*` pages.
 *
 * The personal-settings pages are separate routes with no left rail, so this
 * subnav is the only way to move between them. It must list ALL four pages and
 * render on ALL four — previously each page listed a different subset (or none),
 * stranding the user with no way back or across (#2023).
 */
/**
 * The four personal-settings pages, in nav order. Exported so the ⌘K palette can
 * index them as findable sections (#2319) from this one source — a link added here
 * appears in the subnav and the palette without a second edit. `keywords` folds
 * synonyms into the palette match (not rendered in the subnav).
 */
export const ME_SETTINGS_LINKS: Array<{ to: string; label: string; keywords?: string }> = [
  { to: '/me/settings/general', label: 'General', keywords: 'profile name display language theme locale' },
  { to: '/me/settings/notifications', label: 'Notifications', keywords: 'email alerts digest mentions preferences' },
  { to: '/me/settings/connected-accounts', label: 'Connected accounts', keywords: 'oauth link social jira github google external' },
  { to: '/me/settings/api-tokens', label: 'API tokens', keywords: 'pat personal access token api key secret' },
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
