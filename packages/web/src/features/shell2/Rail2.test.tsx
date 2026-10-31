import { screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { Rail2 } from './Rail2';

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: vi.fn(() => ({
    user: { id: '1', display_name: 'Priya Raman', initials: 'PR', landing: { path: '/me/work' } },
    isLoading: false,
  })),
}));
vi.mock('@/hooks/useNotifications', () => ({
  useUnreadNotificationCount: vi.fn(() => ({ count: 4, isLoading: false })),
}));
vi.mock('@/hooks/usePins', () => ({
  usePinned: vi.fn(() => ({
    data: [
      {
        kind: 'program',
        id: 'pm-1',
        name: 'Platform Modernization',
        code: 'pm',
        program_id: null,
        program_name: null,
        pinned_at: '',
      },
      {
        kind: 'project',
        id: 'pr-1',
        name: 'Atlas Migration',
        code: null,
        program_id: 'pm-1',
        program_name: 'Platform Modernization',
        pinned_at: '',
      },
    ],
  })),
}));
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: vi.fn(() => undefined) }));
vi.mock('@/hooks/useProgramId', () => ({ useProgramId: vi.fn(() => undefined) }));
vi.mock('@/hooks/useProject', () => ({ useProject: vi.fn(() => ({ data: undefined })) }));
vi.mock('@/hooks/usePrograms', () => ({ usePrograms: vi.fn(() => ({ data: [] })) }));
vi.mock('@/hooks/useProjects', () => ({ useProjects: vi.fn(() => ({ data: [] })) }));
// The identity control is the v1 UserMenu, tested on its own; keep it inert here.
vi.mock('@/features/shell/UserMenu', () => ({
  UserMenu: () => <button type="button">Account</button>,
}));

import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';

const mockUseProjectId = useProjectId as ReturnType<typeof vi.fn>;
const mockUseProject = useProject as ReturnType<typeof vi.fn>;

describe('Rail2', () => {
  beforeEach(() => {
    mockUseProjectId.mockReturnValue(undefined);
    mockUseProject.mockReturnValue({ data: undefined });
  });

  it('renders the four global destinations off a program, with the unread count on Inbox', () => {
    renderWithRouter(<Rail2 collapsed={false} />, { initialEntries: ['/me/work'] });
    const nav = screen.getByRole('navigation', { name: 'Destinations' });
    const names = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent?.replace(/unread: /, '').trim());
    expect(names).toEqual(['Home', 'Inbox4', 'Work', 'People']);
    expect(within(nav).getByRole('link', { name: /Home/ })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: /Inbox/ })).not.toHaveAttribute('aria-current');
  });

  it('adds Agents when the project in context belongs to a program', () => {
    mockUseProjectId.mockReturnValue('pr-1');
    mockUseProject.mockReturnValue({
      data: { id: 'pr-1', name: 'Atlas', program_detail: { id: 'pm-1', name: 'PM' } },
    });
    renderWithRouter(<Rail2 collapsed={false} />, { initialEntries: ['/projects/pr-1/schedule'] });
    const nav = screen.getByRole('navigation', { name: 'Destinations' });
    expect(within(nav).getByRole('link', { name: 'Agents' })).toHaveAttribute(
      'href',
      '/programs/pm-1/agents',
    );
    expect(within(nav).getByRole('link', { name: 'Work' })).toHaveAttribute('aria-current', 'page');
  });

  it('lists pins under the destinations and lights the one in context', () => {
    mockUseProjectId.mockReturnValue('pr-1');
    renderWithRouter(<Rail2 collapsed={false} />, { initialEntries: ['/projects/pr-1/overview'] });
    const pinned = screen.getByRole('navigation', { name: 'Pinned' });
    expect(within(pinned).getByRole('link', { name: 'Platform Modernization' })).toHaveAttribute(
      'href',
      '/programs/pm/overview',
    );
    expect(within(pinned).getByRole('link', { name: 'Atlas Migration' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('collapsed: keeps every label in the DOM as sr-only, hides pins, and turns Work into the flyout trigger', () => {
    renderWithRouter(<Rail2 collapsed />, { initialEntries: ['/me/work'] });
    expect(screen.getByRole('complementary', { name: 'Primary navigation' })).toHaveAttribute(
      'data-collapsed',
      'true',
    );
    const nav = screen.getByRole('navigation', { name: 'Destinations' });
    const home = within(nav).getByRole('link', { name: 'Home' });
    expect(within(home).getByText('Home')).toHaveClass('sr-only');
    expect(within(nav).getByRole('link', { name: 'Work' })).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    );
    expect(screen.queryByRole('navigation', { name: 'Pinned' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toBeInTheDocument();
  });

  it('carries no health dots and no settings gear — the two things the rail no longer does', () => {
    renderWithRouter(<Rail2 collapsed={false} />, { initialEntries: ['/me/work'] });
    expect(screen.queryByRole('link', { name: /settings/i })).toBeNull();
    expect(screen.queryByText(/on track|at risk|critical/i)).toBeNull();
  });
});
