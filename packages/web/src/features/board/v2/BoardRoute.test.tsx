import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setFeatureFlag } from '@/lib/featureFlags';
import { SHELL_V2_FLAG } from '@/features/shell2/ShellGate';
import { BoardRoute } from './BoardRoute';

vi.mock('../BoardView', () => ({ BoardView: () => <div>v1 board</div> }));
vi.mock('./Board2Page', () => ({ Board2Page: () => <div>v2 board</div> }));

describe('BoardRoute', () => {
  beforeEach(() => localStorage.clear());

  it('renders the v1 board with the flag off', async () => {
    setFeatureFlag(SHELL_V2_FLAG, false);
    render(<BoardRoute />);
    expect(await screen.findByText('v1 board')).toBeTruthy();
    expect(screen.queryByText('v2 board')).toBeNull();
  });

  it('renders the Pass 2 board with the flag on', async () => {
    setFeatureFlag(SHELL_V2_FLAG, true);
    render(<BoardRoute />);
    expect(await screen.findByText('v2 board')).toBeTruthy();
  });
});
