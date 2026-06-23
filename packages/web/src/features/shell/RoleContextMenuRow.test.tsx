import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RoleContextMenuRow } from './RoleContextMenuRow';

// Controllable mocks for the two hooks the row consumes.
const hookState = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
}));
const currentUser = vi.hoisted(() => ({ user: { role_context: 'unified' as string } }));

vi.mock('@/hooks/useRoleContext', () => ({ useUpdateRoleContext: () => hookState }));
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => currentUser }));

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { value: online, configurable: true });
}

describe('RoleContextMenuRow', () => {
  beforeEach(() => {
    hookState.mutate = vi.fn();
    hookState.isPending = false;
    hookState.isError = false;
    currentUser.user = { role_context: 'unified' };
    setOnline(true);
  });
  afterEach(() => setOnline(true));

  it('renders the View focus segmented group reflecting the stored lens', () => {
    render(<RoleContextMenuRow isMobile={false} />);
    expect(screen.getByRole('group', { name: 'View focus' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unified Today' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'PM' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('optimistically reflects the click and writes the lens', () => {
    render(<RoleContextMenuRow isMobile={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scrum Master' }));
    expect(hookState.mutate).toHaveBeenCalledWith('scrum_master', expect.any(Object));
    // Optimistic: the clicked segment is now pressed without waiting for the server.
    expect(screen.getByRole('button', { name: 'Scrum Master' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('reverts the optimistic selection when the save fails', () => {
    hookState.mutate = vi.fn((_value, opts?: { onError?: () => void }) => opts?.onError?.());
    hookState.isError = true;
    render(<RoleContextMenuRow isMobile={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'PM' }));
    // Reverted back to the server value, and the error line is announced.
    expect(screen.getByRole('button', { name: 'Unified Today' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(/Couldn.t save\. Try again\./);
  });

  it('does not write while offline and disables the control', () => {
    setOnline(false);
    render(<RoleContextMenuRow isMobile={false} />);
    const pm = screen.getByRole('button', { name: 'PM' });
    expect(pm).toBeDisabled();
    fireEvent.click(pm);
    expect(hookState.mutate).not.toHaveBeenCalled();
  });
});
