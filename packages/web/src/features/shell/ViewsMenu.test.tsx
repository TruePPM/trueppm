import { screen, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { ViewsMenu } from './ViewsMenu';

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: vi.fn(() => 'proj-1') }));
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: vi.fn(() => ({ role: 200, isLoading: false })),
}));
vi.mock('@/hooks/useProject', () => ({
  useProject: vi.fn(() => ({
    data: { id: 'proj-1', methodology: 'HYBRID', effective_methodology: 'HYBRID' },
    isLoading: false,
  })),
}));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: vi.fn(() => ({ user: { hidden_views: [] }, isLoading: false })),
}));
vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: vi.fn(() => ({ singular: 'Sprint', plural: 'Sprints' })),
}));

const mutate = vi.fn();
vi.mock('@/hooks/useUpdateHiddenViews', () => ({
  useUpdateHiddenViews: vi.fn(() => ({ mutate })),
}));

import { useProjectId } from '@/hooks/useProjectId';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useProject } from '@/hooks/useProject';
const mockUseProjectId = useProjectId as ReturnType<typeof vi.fn>;
const mockUseRole = useCurrentUserRole as ReturnType<typeof vi.fn>;
const mockUseCurrentUser = useCurrentUser as ReturnType<typeof vi.fn>;
const mockUseProject = useProject as ReturnType<typeof vi.fn>;

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Customize views' }));
}

describe('ViewsMenu (ADR-0139)', () => {
  beforeEach(() => {
    mutate.mockClear();
    mockUseProjectId.mockReturnValue('proj-1');
    mockUseRole.mockReturnValue({ role: 200, isLoading: false }); // SCHEDULER
    mockUseCurrentUser.mockReturnValue({ user: { hidden_views: [] }, isLoading: false });
    mockUseProject.mockReturnValue({
      data: { id: 'proj-1', methodology: 'HYBRID', effective_methodology: 'HYBRID' },
      isLoading: false,
    });
  });

  it('renders nothing off a project route', () => {
    mockUseProjectId.mockReturnValue(undefined);
    const { container } = renderWithRouter(<ViewsMenu />, { initialEntries: ['/me/work'] });
    expect(container.firstChild).toBeNull();
  });

  it('lists both always-on views without a toggle, and hideable views with one', () => {
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    const menu = screen.getByRole('menu', { name: 'Customize views' });
    // ADR-0942 §6: `overview` (labelled Dashboard) and `settings` are band members now
    // but are NOT hideable. Offering either a toggle would PATCH a key the server
    // answers with a 400 — the exact trap the authored vocabulary exists to close.
    expect(within(menu).getByText('Dashboard')).toBeInTheDocument();
    expect(within(menu).getByText('Settings')).toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitemcheckbox', { name: /Dashboard/i }),
    ).not.toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitemcheckbox', { name: /^Settings$/ }),
    ).not.toBeInTheDocument();
    // Hideable views are menuitemcheckbox rows, checked (visible) by default.
    const schedule = within(menu).getByRole('menuitemcheckbox', { name: 'Schedule' });
    expect(schedule).toHaveAttribute('aria-checked', 'true');
    // Team is hideable and lives under the WORKSPACE header now.
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Team' })).toBeInTheDocument();
  });

  it('omits the Team toggle for a role below Scheduler', () => {
    // The Scheduler+ gate on `resources` is duplicated in this component and in
    // `useGroupedProjectViews`; without a test here the ViewsMenu copy could diverge
    // and start offering a toggle for a view this user cannot reach.
    // `mockReturnValue`, not `…Once`: opening the menu is a state change, so the
    // component re-renders and a one-shot mock would serve SCHEDULER to the render
    // that actually builds the list — the test would pass against a deleted gate.
    mockUseRole.mockReturnValue({ role: 100, isLoading: false }); // MEMBER
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Team' })).not.toBeInTheDocument();
    // The rest of the menu still renders — only Team is gated.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Schedule' })).toBeInTheDocument();
  });

  it('omits the always-on Settings row for a user who cannot reach project settings', () => {
    // A member must not be told a surface is "always shown" when the rail does not show
    // it to them at all — the same admin gate the composition seam applies.
    mockUseCurrentUser.mockReturnValue({
      user: { hidden_views: [], can_access_admin_settings: false },
      isLoading: false,
    });
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    const menu = screen.getByRole('menu', { name: 'Customize views' });
    expect(within(menu).getByText('Dashboard')).toBeInTheDocument();
    expect(within(menu).queryByText('Settings')).not.toBeInTheDocument();
  });

  it('toggling a visible view PATCHes it into the hidden set', () => {
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Schedule' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual(['schedule']);
  });

  it('un-toggling an already-hidden view removes it from the set', () => {
    mockUseCurrentUser.mockReturnValue({
      user: { hidden_views: ['schedule', 'calendar'] },
      isLoading: false,
    });
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    const schedule = screen.getByRole('menuitemcheckbox', { name: 'Schedule' });
    expect(schedule).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(schedule);
    expect(mutate.mock.calls[0][0]).toEqual(['calendar']);
  });

  it('Reset clears the methodology-visible hidden views and is disabled when none are hidden', () => {
    mockUseCurrentUser.mockReturnValue({
      user: { hidden_views: ['schedule'] },
      isLoading: false,
    });
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    const reset = screen.getByRole('menuitem', { name: /Reset to Hybrid default/i });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);
    expect(mutate.mock.calls[0][0]).toEqual([]);
  });

  it('Reset is disabled when nothing is hidden', () => {
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    expect(screen.getByRole('menuitem', { name: /Reset to Hybrid default/i })).toBeDisabled();
  });

  it('only lists methodology-visible views as toggles (AGILE hides Schedule/Calendar)', () => {
    mockUseProject.mockReturnValue({
      data: { id: 'proj-1', methodology: 'AGILE', effective_methodology: 'AGILE' },
      isLoading: false,
    });
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Schedule' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: /Sprints/i })).toBeInTheDocument();
  });

  it('no longer offers a Schedule-in-Deliver placement toggle (ADR-0942 §3, #3137)', () => {
    // The opt-in let `schedule` sit in PLAN and DELIVER at once. One home per item, per
    // render: a nav item listed twice is two objects to the person using it, and the
    // control that produced that is gone along with its server field.
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    const menu = screen.getByRole('menu', { name: 'Customize views' });
    expect(
      within(menu).queryByRole('menuitemcheckbox', { name: /under Deliver/i }),
    ).not.toBeInTheDocument();
    expect(within(menu).queryByText(/Placement/i)).not.toBeInTheDocument();
    // Schedule is still offered as an ordinary hide/show toggle — the retirement removed
    // a placement control, not the view.
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Schedule' })).toBeInTheDocument();
  });
  describe('the hidden-views PATCH waits for /auth/me/ to answer (#3214)', () => {
    it('does not PATCH when a view is toggled before the user has loaded', () => {
      // `serverHidden` is `user?.hidden_views ?? []`, so an unanswered query and a
      // user who hides nothing arrive here as the same value. The PATCH sends the
      // FULL replacement set, not a delta, so a toggle in that window would send
      // `['board']` and silently un-hide every other view this user had hidden —
      // server-side, on every device. This menu is mounted on every project route,
      // so the exposure window is the widest of the two ADR-0139 surfaces.
      //
      // Honest scope: the source carries both `disabled={!user}` on the row and
      // `if (!user) return;` in `commit()`. jsdom will not dispatch through a
      // disabled button, so this goes red only when BOTH are removed.
      mockUseCurrentUser.mockReturnValue({ user: undefined, isLoading: true });
      renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
      open();

      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Board/i }));

      expect(mutate).not.toHaveBeenCalled();
    });

    it('renders the rows inert while the user is unknown', () => {
      mockUseCurrentUser.mockReturnValue({ user: undefined, isLoading: true });
      renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
      open();

      expect(screen.getByRole('menuitemcheckbox', { name: /Board/i })).toBeDisabled();
    });

    it('still PATCHes once the user has answered, preserving the existing hidden set', () => {
      // The other half of the guard: it must DELAY the write, not disable it. An
      // empty `hidden_views` from a query that has answered is a real answer, and a
      // user with views already hidden must keep them when hiding one more.
      mockUseCurrentUser.mockReturnValue({
        user: { hidden_views: ['grid'], schedule_in_deliver: false },
        isLoading: false,
      });
      renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
      open();

      const board = screen.getByRole('menuitemcheckbox', { name: /Board/i });
      expect(board).toBeEnabled();
      fireEvent.click(board);

      expect(mutate).toHaveBeenCalledWith(['grid', 'board'], expect.anything());
    });
  });
});
