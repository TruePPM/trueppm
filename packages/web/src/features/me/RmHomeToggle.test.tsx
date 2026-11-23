import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { setFeatureFlag } from '@/lib/featureFlags';
import { SHELL_V2_FLAG } from '@/features/shell2/shellFlag';
import { RmHomeToggle } from './RmHomeToggle';

const st = vi.hoisted(() => ({ home: 'pm', mutate: vi.fn(), isError: false }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { landing: { home: st.home } } }),
}));
vi.mock('@/hooks/useHomeOverride', () => ({
  useUpdateHomeOverride: () => ({ mutate: st.mutate, isPending: false, isError: st.isError }),
}));

describe('RmHomeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    setFeatureFlag(SHELL_V2_FLAG, true);
    st.home = 'pm';
    st.isError = false;
    st.mutate.mockClear();
  });

  it('renders nothing with the flag off', () => {
    setFeatureFlag(SHELL_V2_FLAG, false);
    renderWithProviders(<RmHomeToggle offline={false} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('turning it on sets home_override rm; turning it off clears it', () => {
    const { unmount } = renderWithProviders(<RmHomeToggle offline={false} />);
    const box = screen.getByRole('checkbox', { name: /Open on the Resource Manager home/ });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(st.mutate).toHaveBeenCalledWith('rm');
    unmount();
    st.home = 'rm';
    renderWithProviders(<RmHomeToggle offline={false} />);
    const on = screen.getByRole('checkbox');
    expect(on).toBeChecked();
    fireEvent.click(on);
    expect(st.mutate).toHaveBeenLastCalledWith(null);
  });

  it('is disabled offline and says why; a failed save shows an alert', () => {
    st.isError = true;
    renderWithProviders(<RmHomeToggle offline />);
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByText(/reconnect to change your home screen/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t save your home screen');
  });
});
