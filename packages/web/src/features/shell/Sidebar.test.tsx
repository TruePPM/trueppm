import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { useShellStore } from '@/stores/shellStore';
import { FIXTURE_PROJECTS } from '@/fixtures/projects';
import { Sidebar } from './Sidebar';

// useProjects now calls the live API — stub it with fixture data for unit tests.
vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({ data: FIXTURE_PROJECTS, isLoading: false, error: null }),
}));

describe('Sidebar', () => {
  beforeEach(() => {
    useShellStore.setState({ sidebarCollapsed: false, sidebarUserControlled: false });
  });

  it('renders project list navigation', () => {
    renderWithRouter(<Sidebar />);
    expect(screen.getByRole('navigation', { name: /project list/i })).toBeInTheDocument();
  });

  it('renders project names from fixture when expanded', () => {
    renderWithRouter(<Sidebar />);
    expect(screen.getByText('Alpha Platform Upgrade')).toBeInTheDocument();
    expect(screen.getByText('Beta Data Migration')).toBeInTheDocument();
  });

  it('toggles sidebar collapse on button click', async () => {
    renderWithRouter(<Sidebar />);
    const toggle = screen.getByRole('button', { name: /collapse sidebar/i });
    await userEvent.click(toggle);
    expect(useShellStore.getState().sidebarCollapsed).toBe(true);
    expect(useShellStore.getState().sidebarUserControlled).toBe(true);
  });

  it('calls onClose when Escape pressed in drawer mode', async () => {
    const onClose = vi.fn();
    renderWithRouter(<Sidebar isDrawer onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});
