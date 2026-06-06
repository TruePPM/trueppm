import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { useShellStore } from '@/stores/shellStore';
import { FIXTURE_PROJECTS } from '@/fixtures/projects';
import type { Program } from '@/api/types';
import type { Project } from '@/types';
import { Sidebar } from './Sidebar';

// Module-level state used by the useProjects mock below.
let mockProjectsResult: {
  data: Project[] | undefined;
  isLoading: boolean;
  error: Error | null;
} = { data: FIXTURE_PROJECTS, isLoading: false, error: null };

// useProjects now calls the live API — stub it with fixture data for unit tests.
vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => mockProjectsResult,
}));

// usePrograms drives the scope picker (#959). Two programs so we can exercise
// scoping; cast keeps the fixture terse without spelling out every Program field.
const FIXTURE_PROGRAMS = [
  { id: 'p1', name: 'Phoenix Program' },
  { id: 'p2', name: 'Atlas Program' },
] as unknown as Program[];
let mockProgramsResult: { data: Program[] | undefined } = { data: FIXTURE_PROGRAMS };
vi.mock('@/hooks/usePrograms', () => ({
  usePrograms: () => mockProgramsResult,
}));

// Stub the New Program modal — its real behavior is covered in NewProgramModal.test.tsx.
vi.mock('@/features/programs/NewProgramModal', () => ({
  NewProgramModal: ({ onClose }: { onClose: () => void; onCreated: (id: string) => void }) => (
    <div role="dialog" aria-label="New program">
      <button onClick={onClose}>Cancel program</button>
    </div>
  ),
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
    useShellStore.setState({
      sidebarCollapsed: false,
      sidebarUserControlled: false,
      projectScope: 'all',
    });
    mockProjectsResult = { data: FIXTURE_PROJECTS, isLoading: false, error: null };
    mockProgramsResult = { data: FIXTURE_PROGRAMS };
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

  it('hides the collapse toggle but shows the scoped list in drawer mode', () => {
    renderWithRouter(<Sidebar isDrawer />);
    // The collapse toggle is desktop-only.
    expect(screen.queryByRole('button', { name: /collapse sidebar/i })).not.toBeInTheDocument();
    // The scoped list (picker + projects header) renders in the drawer — mobile
    // benefits most from scoping/search (#959).
    expect(screen.getByRole('heading', { name: /^Projects,/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Program scope:/i })).toBeInTheDocument();
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

  // ── #959: scoped program picker + in-scope search ──────────────────────
  const SCOPED_PROJECTS: Project[] = [
    { id: 'a', name: 'Phoenix Rollout', colorDot: '#3E8C6D', healthState: 'unknown', methodology: 'HYBRID', programId: 'p1' },
    { id: 'b', name: 'Atlas Migration', colorDot: '#E8A020', healthState: 'unknown', methodology: 'HYBRID', programId: 'p2' },
    { id: 'c', name: 'Standalone Thing', colorDot: '#B91C1C', healthState: 'unknown', methodology: 'HYBRID', programId: null },
  ];

  it('groups projects under collapsible program headers in the "All programs" scope', async () => {
    mockProjectsResult = { data: SCOPED_PROJECTS, isLoading: false, error: null };
    renderWithRouter(<Sidebar />);
    // Group headers for each program plus the orphan "No program" group.
    expect(screen.getByRole('button', { name: /Phoenix Program/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Atlas Program/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /No program/i })).toBeInTheDocument();
    // Projects are visible while their group is expanded.
    expect(screen.getByText('Phoenix Rollout')).toBeInTheDocument();

    // Collapsing a group hides its projects.
    await userEvent.click(screen.getByRole('button', { name: /Phoenix Program/i }));
    expect(screen.queryByText('Phoenix Rollout')).not.toBeInTheDocument();
    expect(screen.getByText('Atlas Migration')).toBeInTheDocument();
  });

  it('renders a flat list with no group headers when scoped to one program', () => {
    mockProjectsResult = { data: SCOPED_PROJECTS, isLoading: false, error: null };
    useShellStore.setState({ projectScope: 'p1' });
    renderWithRouter(<Sidebar />);
    expect(screen.getByText('Phoenix Rollout')).toBeInTheDocument();
    expect(screen.queryByText('Atlas Migration')).not.toBeInTheDocument();
    // No collapsible program group header in a single-program scope.
    expect(screen.queryByRole('button', { name: /Atlas Program/i })).not.toBeInTheDocument();
  });

  it('filters the project list to the selected program scope', async () => {
    mockProjectsResult = { data: SCOPED_PROJECTS, isLoading: false, error: null };
    renderWithRouter(<Sidebar />);
    // All three show under the default "All programs" scope.
    expect(screen.getByText('Phoenix Rollout')).toBeInTheDocument();
    expect(screen.getByText('Atlas Migration')).toBeInTheDocument();
    expect(screen.getByText('Standalone Thing')).toBeInTheDocument();

    // Open the picker and scope to Phoenix Program.
    await userEvent.click(screen.getByRole('button', { name: /Program scope:/i }));
    await userEvent.click(screen.getByRole('option', { name: /Phoenix Program/i }));

    expect(screen.getByText('Phoenix Rollout')).toBeInTheDocument();
    expect(screen.queryByText('Atlas Migration')).not.toBeInTheDocument();
    expect(screen.queryByText('Standalone Thing')).not.toBeInTheDocument();
    // Scope is persisted to the store so the drawer instance stays in sync.
    expect(useShellStore.getState().projectScope).toBe('p1');
  });

  it('scopes to projects with no program via the "No program" option', async () => {
    mockProjectsResult = { data: SCOPED_PROJECTS, isLoading: false, error: null };
    renderWithRouter(<Sidebar />);
    await userEvent.click(screen.getByRole('button', { name: /Program scope:/i }));
    await userEvent.click(screen.getByRole('option', { name: /No program/i }));
    expect(screen.getByText('Standalone Thing')).toBeInTheDocument();
    expect(screen.queryByText('Phoenix Rollout')).not.toBeInTheDocument();
  });

  it('narrows the visible projects with the in-scope search box', async () => {
    mockProjectsResult = { data: SCOPED_PROJECTS, isLoading: false, error: null };
    renderWithRouter(<Sidebar />);
    await userEvent.type(screen.getByRole('textbox', { name: /Search projects/i }), 'atlas');
    expect(screen.getByText('Atlas Migration')).toBeInTheDocument();
    expect(screen.queryByText('Phoenix Rollout')).not.toBeInTheDocument();
    expect(screen.queryByText('Standalone Thing')).not.toBeInTheDocument();
  });

  it('shows a "No projects match" status when search excludes everything', async () => {
    mockProjectsResult = { data: SCOPED_PROJECTS, isLoading: false, error: null };
    renderWithRouter(<Sidebar />);
    await userEvent.type(screen.getByRole('textbox', { name: /Search projects/i }), 'zzz-nomatch');
    expect(screen.getByText(/No projects match/i)).toBeInTheDocument();
  });

  it('filters the scope picker options with its own search input', async () => {
    mockProjectsResult = { data: SCOPED_PROJECTS, isLoading: false, error: null };
    renderWithRouter(<Sidebar />);
    await userEvent.click(screen.getByRole('button', { name: /Program scope:/i }));
    const listbox = screen.getByRole('listbox', { name: /Program scope/i });
    expect(within(listbox).getByRole('option', { name: /Phoenix Program/i })).toBeInTheDocument();
    await userEvent.type(screen.getByRole('combobox', { name: /Filter programs/i }), 'atlas');
    expect(within(listbox).getByRole('option', { name: /Atlas Program/i })).toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: /Phoenix Program/i })).not.toBeInTheDocument();
  });

  it('opens the New Program modal from the scope picker', async () => {
    renderWithRouter(<Sidebar />);
    await userEvent.click(screen.getByRole('button', { name: /New program/i }));
    expect(screen.getByRole('dialog', { name: /New program/i })).toBeInTheDocument();
  });
});
