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
});
