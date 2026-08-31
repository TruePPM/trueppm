import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ViewVisibilitySection } from './ViewVisibilitySection';

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: vi.fn(() => ({ user: { hidden_views: [] }, isLoading: false })),
}));
const mutate = vi.fn();
vi.mock('@/hooks/useUpdateHiddenViews', () => ({
  useUpdateHiddenViews: vi.fn(() => ({ mutate })),
}));

import { useCurrentUser } from '@/hooks/useCurrentUser';
const mockUseCurrentUser = useCurrentUser as ReturnType<typeof vi.fn>;

describe('ViewVisibilitySection (ADR-0139)', () => {
  beforeEach(() => {
    mutate.mockClear();
    mockUseCurrentUser.mockReturnValue({ user: { hidden_views: [] }, isLoading: false });
  });

  it('lists every hideable view as a switch, and both always-on views without one', () => {
    render(<ViewVisibilitySection />);
    // ADR-0942 §6: `overview` (now labelled Dashboard) and `settings` are band members
    // but not hideable. Offering a switch for either would emit a PATCH the server
    // rejects with a 400, so they render as static always-on rows.
    expect(screen.getByText(/^Dashboard — always shown$/)).toBeInTheDocument();
    expect(screen.getByText(/^Settings — always shown$/)).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /^Dashboard/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /^Settings/ })).not.toBeInTheDocument();
    // Switches are shown=on by default. `^Board` anchors the name: "Dashboard" contains
    // "board", so an unanchored /Board/i matches the always-on row too.
    const board = screen.getByRole('switch', { name: /^Board — shown/i });
    expect(board).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: /Schedule — shown/i })).toBeInTheDocument();
    // Team stays hideable and stays labelled "Team" — it moved bands, not vocabulary.
    expect(screen.getByRole('switch', { name: /^Team — shown/i })).toBeInTheDocument();
  });

  it('toggling a switch off PATCHes the view into the hidden set', () => {
    render(<ViewVisibilitySection />);
    fireEvent.click(screen.getByRole('switch', { name: /Schedule — shown/i }));
    expect(mutate).toHaveBeenCalledWith(['schedule'], expect.anything());
  });

  it('reflects a hidden view as off and Reset clears the set', () => {
    mockUseCurrentUser.mockReturnValue({
      user: { hidden_views: ['schedule'] },
      isLoading: false,
    });
    render(<ViewVisibilitySection />);
    expect(screen.getByRole('switch', { name: /Schedule — hidden/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    const reset = screen.getByRole('button', { name: /Reset to default/i });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);
    expect(mutate).toHaveBeenCalledWith([], expect.anything());
  });

  it('disables Reset when nothing is hidden', () => {
    render(<ViewVisibilitySection />);
    expect(screen.getByRole('button', { name: /Reset to default/i })).toBeDisabled();
  });

  describe('the hidden-views PATCH waits for /auth/me/ to answer (#3214)', () => {
    it('does not PATCH when a switch is clicked before the user has loaded', () => {
      // `serverHidden` is `user?.hidden_views ?? []`, so an unanswered query and a
      // user who hides nothing arrive here as the same value. The PATCH sends the
      // FULL replacement set, so a click in that window would send `['schedule']`
      // and silently un-hide everything else this user had hidden — server-side,
      // on every device.
      //
      // Honest scope: the source carries TWO protections — `disabled={!user}` on
      // the switch and `if (!user) return;` in `commit()`. jsdom will not dispatch
      // a click through a disabled button (and clearing the attribute by hand does
      // not restore React 19's dispatch), so this assertion is satisfied by
      // whichever protection is present and goes red only when BOTH are removed.
      // It is not evidence about the `commit` guard alone; that guard is
      // defense-in-depth for a future caller that is not this button.
      mockUseCurrentUser.mockReturnValue({ user: undefined, isLoading: true });
      render(<ViewVisibilitySection />);

      fireEvent.click(screen.getByRole('switch', { name: /Schedule — shown/i }));

      expect(mutate).not.toHaveBeenCalled();
    });

    it('renders the switches inert while the user is unknown, rather than silently ignoring clicks', () => {
      mockUseCurrentUser.mockReturnValue({ user: undefined, isLoading: true });
      render(<ViewVisibilitySection />);

      expect(screen.getByRole('switch', { name: /Schedule — shown/i })).toBeDisabled();
    });

    it('still PATCHes once the user has answered — the guard delays the write, it does not disable it', () => {
      // The other half: an empty `hidden_views` from a query that HAS answered is a
      // real answer, and toggling against it must still commit. A test that only
      // pinned "nothing was sent" would pass with the feature deleted entirely.
      mockUseCurrentUser.mockReturnValue({ user: { hidden_views: [] }, isLoading: false });
      render(<ViewVisibilitySection />);

      const schedule = screen.getByRole('switch', { name: /Schedule — shown/i });
      expect(schedule).toBeEnabled();
      fireEvent.click(schedule);

      expect(mutate).toHaveBeenCalledWith(['schedule'], expect.anything());
    });

    it('preserves an existing hidden set when the toggle lands after the answer', () => {
      // The regression this guards, stated as the value that must survive: a user
      // with four hidden views hides a fifth and keeps all five.
      mockUseCurrentUser.mockReturnValue({
        user: { hidden_views: ['board', 'grid', 'reports', 'sprints'] },
        isLoading: false,
      });
      render(<ViewVisibilitySection />);

      fireEvent.click(screen.getByRole('switch', { name: /Schedule — shown/i }));

      expect(mutate).toHaveBeenCalledWith(
        ['board', 'grid', 'reports', 'sprints', 'schedule'],
        expect.anything(),
      );
    });
  });
});
