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

  it('lists every hideable view as a switch and Overview as always-on (no switch)', () => {
    render(<ViewVisibilitySection />);
    expect(screen.getByText(/Overview — always shown/i)).toBeInTheDocument();
    // Switches are shown=on by default.
    const board = screen.getByRole('switch', { name: /Board — shown/i });
    expect(board).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: /Schedule — shown/i })).toBeInTheDocument();
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
