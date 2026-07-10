import type { ComponentProps } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import { MoreSheet } from './MoreSheet';

function renderSheet(
  overrides: Partial<ComponentProps<typeof MoreSheet>> = {},
  initialEntries: string[] = ['/'],
) {
  const props: ComponentProps<typeof MoreSheet> = {
    isOpen: true,
    onClose: vi.fn(),
    projectId: 'proj-1',
    views: ['risk', 'reports', 'settings'],
    barViews: [],
    pinnedViews: [],
    onTogglePin: vi.fn(),
    currentView: 'board',
    isSettingsActive: false,
    sprintsLabel: 'Sprints',
    ...overrides,
  };
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <MoreSheet {...props} />
    </MemoryRouter>,
  );
}

describe('MoreSheet', () => {
  it('surfaces My Work as the first personal destination (#1770)', () => {
    renderSheet();
    // My Work is a cross-project route, not a project view — it is pinned to the
    // top of the sheet so a phone user reaches it without a nav-drawer scroll.
    const myWork = screen.getByRole('link', { name: 'My Work' });
    expect(myWork).toHaveAttribute('href', '/me/work');
  });

  it('still lists the overflow project views alongside My Work', () => {
    renderSheet();
    expect(screen.getByRole('link', { name: 'My Work' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Risks' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it('marks the My Work row current on the /me/work route, not elsewhere', () => {
    renderSheet();
    expect(screen.getByRole('link', { name: 'My Work' })).not.toHaveAttribute(
      'aria-current',
      'page',
    );

    renderSheet({}, ['/me/work']);
    // NavLink sets aria-current="page" when its route is active — so the row reads
    // as selected for screen readers when the user is already on My Work.
    const activeLinks = screen.getAllByRole('link', { name: 'My Work' });
    expect(activeLinks.some((el) => el.getAttribute('aria-current') === 'page')).toBe(true);
  });
});
