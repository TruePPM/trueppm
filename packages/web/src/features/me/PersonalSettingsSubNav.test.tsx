import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router';
import { PersonalSettingsSubNav } from './PersonalSettingsSubNav';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PersonalSettingsSubNav />
    </MemoryRouter>,
  );
}

describe('PersonalSettingsSubNav', () => {
  it('lists all four personal-settings pages with correct hrefs (#2023)', () => {
    renderAt('/me/settings/general');
    const nav = screen.getByRole('navigation', { name: 'Personal settings sections' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'General',
      'Notifications',
      'Connected accounts',
      'Personal access tokens',
    ]);
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/me/settings/general',
      '/me/settings/notifications',
      '/me/settings/connected-accounts',
      '/me/settings/api-tokens',
    ]);
  });

  it('marks the active page with aria-current (NavLink) — api-tokens included', () => {
    renderAt('/me/settings/api-tokens');
    const active = screen.getByRole('link', { name: 'Personal access tokens' });
    expect(active).toHaveAttribute('aria-current', 'page');
    // A sibling is not current.
    expect(screen.getByRole('link', { name: 'General' })).not.toHaveAttribute('aria-current');
  });
});
