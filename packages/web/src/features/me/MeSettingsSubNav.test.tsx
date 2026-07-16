import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect } from 'vitest';
import { MeSettingsSubNav } from './MeSettingsSubNav';

/** Render the subnav with the given active route. */
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MeSettingsSubNav />
    </MemoryRouter>,
  );
}

describe('MeSettingsSubNav (#2023 — all four pages reachable from every page)', () => {
  it('renders links to all four personal-settings pages', () => {
    renderAt('/me/settings/general');
    const nav = screen.getByRole('navigation', { name: 'Personal settings sections' });
    const links = screen.getAllByRole('link');
    expect(nav).toBeInTheDocument();
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/me/settings/general',
      '/me/settings/notifications',
      '/me/settings/connected-accounts',
      '/me/settings/api-tokens',
    ]);
  });

  it('marks the current page as the active link', () => {
    renderAt('/me/settings/api-tokens');
    // `end` matching means only the exact route is active — API tokens here.
    expect(screen.getByRole('link', { name: 'API tokens' })).toHaveClass('font-medium');
    expect(screen.getByRole('link', { name: 'General' })).not.toHaveClass('font-medium');
  });
});
