import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProvidersAndRouter as render } from '@/test/utils';
import { DemoProjectSwitcher } from './DemoProjectSwitcher';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => navigate,
}));

const state = vi.hoisted(() => ({
  projectId: 'p1' as string | null,
  project: undefined as unknown,
  siblings: [] as { id: string; name: string }[],
  isAdmin: null as boolean | null,
}));
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => state.projectId }));
vi.mock('@/hooks/useProject', () => ({ useProject: () => ({ data: state.project }) }));
vi.mock('@/hooks/useProgramProjects', () => ({
  useProgramProjects: () => ({ data: state.siblings }),
}));
vi.mock('@/hooks/useIsWorkspaceAdmin', () => ({ useIsWorkspaceAdmin: () => state.isAdmin }));

const MANAGE = 'Manage demo data';

async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByTestId('demo-project-switcher'));
  return user;
}

describe('DemoProjectSwitcher', () => {
  beforeEach(() => {
    navigate.mockClear();
    state.projectId = 'p1';
    state.project = {
      id: 'p1',
      name: 'Migration Tooling',
      program_detail: { id: 'prog-9', name: 'Atlas Platform Launch' },
    };
    state.siblings = [
      { id: 'p1', name: 'Migration Tooling' },
      { id: 'p2', name: 'Mobile App' },
    ];
    state.isAdmin = null;
  });

  it('shows "Manage demo data" only for a workspace admin and navigates to the program', async () => {
    state.isAdmin = true;
    render(<DemoProjectSwitcher />);
    const user = await openMenu();
    await user.click(screen.getByText(MANAGE));
    expect(navigate).toHaveBeenCalledWith('/programs/prog-9');
  });

  it('hides the footer for a confirmed non-admin (the visitor)', async () => {
    state.isAdmin = false;
    render(<DemoProjectSwitcher />);
    await openMenu();
    expect(screen.getByText('Mobile App')).toBeInTheDocument();
    expect(screen.queryByText(MANAGE)).not.toBeInTheDocument();
  });

  it('hides the footer while the role is unresolved (null is not admin)', async () => {
    state.isAdmin = null;
    render(<DemoProjectSwitcher />);
    await openMenu();
    expect(screen.getByText('Mobile App')).toBeInTheDocument();
    expect(screen.queryByText(MANAGE)).not.toBeInTheDocument();
  });

  it('hides the footer for an admin when the project has no program', async () => {
    state.isAdmin = true;
    state.project = { id: 'p1', name: 'Solo', program_detail: null };
    render(<DemoProjectSwitcher />);
    await openMenu();
    expect(screen.queryByText(MANAGE)).not.toBeInTheDocument();
  });

  it('lists sibling projects (not the current one) and lands on their Schedule', async () => {
    render(<DemoProjectSwitcher />);
    const user = await openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Migration Tooling' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Mobile App' }));
    expect(navigate).toHaveBeenCalledWith('/projects/p2/schedule');
  });

  it('renders nothing off a project route', () => {
    state.projectId = null;
    const { container } = render(<DemoProjectSwitcher />);
    expect(container).toBeEmptyDOMElement();
  });
});
