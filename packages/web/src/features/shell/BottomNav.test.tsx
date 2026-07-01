import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { BottomNav } from './BottomNav';

// Default: has a project ID.
vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: vi.fn(() => 'proj-1'),
}));

// Default: SCHEDULER role so the Team tab is reachable. Role-gate tests override.
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: vi.fn(() => ({ role: 200, isLoading: false })),
}));

// Default: HYBRID (all tabs visible), reporting on, default iteration label.
// BottomNav reads the SERVER-RESOLVED effective_methodology (ADR-0107) and
// per-project effective_surface_visibility (ADR-0193); seed both.
vi.mock('@/hooks/useProject', () => ({
  useProject: vi.fn(() => ({
    data: {
      id: 'proj-1',
      methodology: 'HYBRID',
      effective_methodology: 'HYBRID',
      effective_surface_visibility: { reporting: true },
      iteration_label: null,
    },
    isLoading: false,
    error: null,
  })),
}));

// Default: no personally-hidden views (ADR-0139). Hidden-views tests override.
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: vi.fn(() => ({ user: { hidden_views: [] }, isLoading: false })),
}));

import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useCurrentUser } from '@/hooks/useCurrentUser';

const mockUseProjectId = useProjectId as ReturnType<typeof vi.fn>;
const mockUseProject = useProject as ReturnType<typeof vi.fn>;
const mockUseRole = useCurrentUserRole as ReturnType<typeof vi.fn>;
const mockUseCurrentUser = useCurrentUser as ReturnType<typeof vi.fn>;

function seedProject(overrides: Record<string, unknown> = {}) {
  mockUseProject.mockReturnValue({
    data: {
      id: 'proj-1',
      methodology: 'HYBRID',
      effective_methodology: 'HYBRID',
      effective_surface_visibility: { reporting: true },
      iteration_label: null,
      ...overrides,
    },
    isLoading: false,
    error: null,
  });
}

describe('BottomNav', () => {
  beforeEach(() => {
    mockUseProjectId.mockReturnValue('proj-1');
    mockUseRole.mockReturnValue({ role: 200, isLoading: false });
    mockUseCurrentUser.mockReturnValue({ user: { hidden_views: [] }, isLoading: false });
    seedProject();
  });

  it('renders null when there is no projectId', () => {
    mockUseProjectId.mockReturnValue(null);
    const { container } = renderWithRouter(<BottomNav />, {
      initialEntries: ['/projects/proj-1/overview'],
    });
    expect(container.firstChild).toBeNull();
  });

  it('renders the rail with exactly 5 slots on HYBRID (4 tabs + More)', () => {
    renderWithRouter(<BottomNav />, { initialEntries: ['/projects/proj-1/board'] });
    const nav = screen.getByRole('navigation', { name: /view/i });
    const links = within(nav).getAllByRole('link');
    const moreButton = within(nav).getByRole('button', { name: /^More/ });
    expect(links).toHaveLength(4);
    expect(moreButton).toBeInTheDocument();
  });

  it('leads with Overview and Today as primary tabs (issue 1324)', () => {
    renderWithRouter(<BottomNav />, { initialEntries: ['/projects/proj-1/board'] });
    const nav = screen.getByRole('navigation', { name: /view/i });
    const links = within(nav).getAllByRole('link');
    expect(links[0]).toHaveAccessibleName(/Overview/i);
    expect(links[1]).toHaveAccessibleName(/Today/i);
  });

  it('makes Backlog reachable as a primary tab on HYBRID (issue 1464)', () => {
    renderWithRouter(<BottomNav />, { initialEntries: ['/projects/proj-1/board'] });
    const nav = screen.getByRole('navigation', { name: /view/i });
    expect(within(nav).getByRole('link', { name: /Backlog/i })).toBeInTheDocument();
  });

  it('surfaces Risks and Reports via the More overflow sheet (issue 1464)', async () => {
    const user = userEvent.setup();
    renderWithRouter(<BottomNav />, {
      initialEntries: ['/projects/proj-1/board'],
    });
    // Risks/Reports are not primary — they live behind More.
    const nav = screen.getByRole('navigation', { name: /view/i });
    expect(within(nav).queryByRole('link', { name: /Risks/i })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: /Reports/i })).not.toBeInTheDocument();

    await user.click(within(nav).getByRole('button', { name: /^More/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('link', { name: /Risks/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Reports/i })).toBeInTheDocument();
    // Settings stays reachable via the overflow (issue 539).
    expect(within(dialog).getByRole('link', { name: /Settings/i })).toBeInTheDocument();
  });

  it('marks the More button active when the current surface lives in the overflow (issue 539)', () => {
    renderWithRouter(<BottomNav />, { initialEntries: ['/projects/proj-1/settings'] });
    const nav = screen.getByRole('navigation', { name: /view/i });
    // Settings is overflow-parked, so the More button announces it as selected.
    expect(
      within(nav).getByRole('button', { name: /More, Settings selected/i }),
    ).toBeInTheDocument();
  });

  it('keeps the More label as "Settings" on a settings sub-page, not the sub-segment', () => {
    // A settings sub-route (e.g. /settings/notifications) must still read as
    // "Settings" — the label resolves off the view key, not the trailing
    // segment (issue 539; would otherwise announce "More, view selected").
    renderWithRouter(<BottomNav />, {
      initialEntries: ['/projects/proj-1/settings/notifications'],
    });
    const nav = screen.getByRole('navigation', { name: /view/i });
    expect(
      within(nav).getByRole('button', { name: /More, Settings selected/i }),
    ).toBeInTheDocument();
  });

  it('marks the active primary tab on a nested view route (e.g. a board card)', () => {
    // Active state derives from the segment after the projectId, so a nested
    // detail route keeps its parent view highlighted (matches ViewTabs).
    renderWithRouter(<BottomNav />, {
      initialEntries: ['/projects/proj-1/board/card-42'],
    });
    const nav = screen.getByRole('navigation', { name: /view/i });
    expect(within(nav).getByRole('link', { name: /Board/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('hides the Team tab for roles below Scheduler', () => {
    mockUseRole.mockReturnValue({ role: 100, isLoading: false });
    renderWithRouter(<BottomNav />, { initialEntries: ['/projects/proj-1/board'] });
    // Team must not appear as a primary tab...
    const nav = screen.getByRole('navigation', { name: /view/i });
    expect(within(nav).queryByRole('link', { name: /Team/i })).not.toBeInTheDocument();
  });

  it('respects per-user hidden_views on mobile (ADR-0139 extended to the rail)', async () => {
    mockUseCurrentUser.mockReturnValue({
      user: { hidden_views: ['product-backlog', 'risk'] },
      isLoading: false,
    });
    const user = userEvent.setup();
    renderWithRouter(<BottomNav />, {
      initialEntries: ['/projects/proj-1/board'],
    });
    const nav = screen.getByRole('navigation', { name: /view/i });
    expect(within(nav).queryByRole('link', { name: /Backlog/i })).not.toBeInTheDocument();
    // And it must not resurface in the overflow either.
    const moreButton = within(nav).queryByRole('button', { name: /^More/ });
    if (moreButton) {
      await user.click(moreButton);
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).queryByRole('link', { name: /Backlog/i })).not.toBeInTheDocument();
      expect(within(dialog).queryByRole('link', { name: /Risks/i })).not.toBeInTheDocument();
    }
  });

  it('applies the configured iteration label to the Sprints entry', async () => {
    // Rename iterations to "Cycles"; the overflow Sprints row must follow.
    seedProject({ iteration_label: 'cycle' });
    const user = userEvent.setup();
    renderWithRouter(<BottomNav />, {
      initialEntries: ['/projects/proj-1/board'],
    });
    const nav = screen.getByRole('navigation', { name: /view/i });
    await user.click(within(nav).getByRole('button', { name: /^More/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('link', { name: /Cycles/i })).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: /^Sprints$/i })).not.toBeInTheDocument();
  });
});
