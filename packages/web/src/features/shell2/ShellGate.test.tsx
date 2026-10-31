import { act, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { setFeatureFlag } from '@/lib/featureFlags';
import { ShellGate, SHELL_V2_FLAG } from './ShellGate';

vi.mock('@/features/shell/AppShell', () => ({ AppShell: () => <div data-testid="shell-v1" /> }));
vi.mock('./AppShell2', () => ({ AppShell2: () => <div data-testid="shell2" /> }));

describe('ShellGate', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('mounts the v1 shell by default', () => {
    renderWithRouter(<ShellGate />);
    expect(screen.getByTestId('shell-v1')).toBeInTheDocument();
    expect(screen.queryByTestId('shell2')).toBeNull();
  });

  it('mounts shell v2 when the flag is on, and switches back when it is turned off', () => {
    setFeatureFlag(SHELL_V2_FLAG, true);
    renderWithRouter(<ShellGate />);
    expect(screen.getByTestId('shell2')).toBeInTheDocument();
    act(() => setFeatureFlag(SHELL_V2_FLAG, false));
    expect(screen.getByTestId('shell-v1')).toBeInTheDocument();
  });
});
