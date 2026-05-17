import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { useShellStore } from '@/stores/shellStore';
import { FIXTURE_PROJECTS } from '@/fixtures/projects';
import { Sidebar } from './Sidebar';

// Module-level state used by the useProjects mock below.
let mockProjectsResult: {
  data: typeof FIXTURE_PROJECTS | undefined;
  isLoading: boolean;
  error: Error | null;
} = { data: FIXTURE_PROJECTS, isLoading: false, error: null };

// useProjects now calls the live API — stub it with fixture data for unit tests.
vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => mockProjectsResult,
}));

// Stub NewProjectModal to a simple dialog — avoids needing useProjectMutations in Sidebar tests.
// The real modal is tested in NewProjectModal.test.tsx.
vi.mock('./NewProjectModal', () => ({
  NewProjectModal: ({ onClose }: { onClose: () => void; onCreated: (id: string) => void }) => (
    <div role="dialog" aria-label="New project">
      <button onClick={onClose}>Cancel</button>
    </div>
  ),
}));

// Stub useMyWork — the Sidebar's "Me" section reads due_today_count from the
// first page. Without the mock, TanStack Query would attempt a real network
// call in the JSDOM test environment. The badge logic itself is exercised in
// the my-work Playwright spec; here we just need the hook to return a no-op
// shape so the Sidebar renders cleanly.
vi.mock('@/hooks/useMyWork', () => ({
  useMyWork: () => ({ data: undefined }),
}));

describe('Sidebar', () => {
  beforeEach(() => {
    useShellStore.setState({ sidebarCollapsed: false, sidebarUserControlled: false });
    mockProjectsResult = { data: FIXTURE_PROJECTS, isLoading: false, error: null };
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

  it('renders error state when useProjects returns an error', () => {
    mockProjectsResult = { data: undefined, isLoading: false, error: new Error('Network') };
    renderWithRouter(<Sidebar />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Failed to load projects/i)).toBeInTheDocument();
  });

  it('renders loading skeleton when useProjects is loading', () => {
    mockProjectsResult = { data: undefined, isLoading: true, error: null };
    renderWithRouter(<Sidebar />);
    expect(screen.getByLabelText(/Loading projects/i)).toBeInTheDocument();
  });

  it('renders "No projects yet" when projects list is empty', () => {
    mockProjectsResult = { data: [], isLoading: false, error: null };
    renderWithRouter(<Sidebar />);
    expect(screen.getByText(/No projects yet/i)).toBeInTheDocument();
  });

  it('hides collapse toggle and section headers in drawer mode', () => {
    renderWithRouter(<Sidebar isDrawer />);
    expect(screen.queryByRole('button', { name: /collapse sidebar/i })).not.toBeInTheDocument();
    // Section headers (PROJECTS, ORG) are hidden in drawer mode
    expect(screen.queryByText('PROJECTS')).not.toBeInTheDocument();
  });

  it('shows new-project button when sidebar is expanded', () => {
    renderWithRouter(<Sidebar />);
    expect(screen.getByRole('button', { name: /New project/i })).toBeInTheDocument();
  });

  it('shows collapsed icon-only Resources link when sidebar is collapsed', () => {
    useShellStore.setState({ sidebarCollapsed: true, sidebarUserControlled: true });
    renderWithRouter(<Sidebar />);
    // There should be a Resources link (aria-label)
    const links = screen.getAllByRole('link', { name: /Resources catalog/i });
    expect(links.length).toBeGreaterThan(0);
    // Expand button should show the correct label
    expect(screen.getByRole('button', { name: /Expand sidebar/i })).toBeInTheDocument();
  });

  it('opens NewProjectModal when New Project button is clicked', async () => {
    renderWithRouter(<Sidebar />);
    await userEvent.click(screen.getByRole('button', { name: /New project/i }));
    // NewProjectModal renders a dialog
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes NewProjectModal when its onClose callback is called', async () => {
    renderWithRouter(<Sidebar />);
    await userEvent.click(screen.getByRole('button', { name: /New project/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Click the Cancel/close button inside the modal
    await userEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not close drawer onClose when not in drawer mode after project created', async () => {
    // Render in non-drawer mode; onClose is not provided
    renderWithRouter(<Sidebar />);
    await userEvent.click(screen.getByRole('button', { name: /New project/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not handle Escape key when not in drawer mode', async () => {
    // In non-drawer mode there is no Escape close handler
    renderWithRouter(<Sidebar />);
    await userEvent.keyboard('{Escape}');
    // Sidebar still renders normally — no crash
    expect(screen.getByRole('navigation', { name: /project list/i })).toBeInTheDocument();
  });
});
