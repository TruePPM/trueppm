import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import { ProgramProjectsPage } from './ProgramProjectsPage';
import { ROLE_VIEWER } from '@/lib/roles';

const useProgram = vi.fn();
const useProgramProjects = vi.fn();

vi.mock('@/hooks/useProgram', () => ({
  useProgram: () => useProgram() as { data: unknown },
}));

vi.mock('@/hooks/useProgramProjects', () => ({
  useProgramProjects: () =>
    useProgramProjects() as { data: unknown; isLoading: boolean; error: Error | null },
}));

// The bulk-edit matrix (#1233) reads the workspace methodology policy (for the rule-196
// lock) and posts via the bulk-fields hook; stub both so the page renders offline.
vi.mock('../hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => ({ data: { methodologyOverridePolicy: 'suggest' } }),
}));
vi.mock('@/hooks/useBulkProjectFields', () => ({
  useBulkProjectFields: () => ({ mutateAsync: vi.fn().mockResolvedValue({ updated: [], fields: [] }), isPending: false }),
}));

// The Add modal renders into a portal and pulls in unrelated mutation hooks; stub it.
vi.mock('@/features/programs/AddProjectToProgramModal', () => ({
  AddProjectToProgramModal: () => <div data-testid="add-modal" />,
}));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/programs/p-1/settings/projects']}>
        <Routes>
          <Route path="/programs/:programId/settings/projects" element={<ProgramProjectsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProgramProjectsPage (settings)', () => {
  it('renders skeleton while loading', () => {
    useProgram.mockReturnValue({ data: undefined });
    useProgramProjects.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderPage();
    expect(screen.getByLabelText(/Loading projects/i)).toBeInTheDocument();
  });

  it('renders error state when query fails', () => {
    useProgram.mockReturnValue({ data: undefined });
    useProgramProjects.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
    });
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(/Failed to load projects/i);
  });

  it('renders empty state when program has no projects', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', name: 'Phase 2', my_role: 400 } });
    useProgramProjects.mockReturnValue({ data: [], isLoading: false, error: null });
    renderPage();
    expect(screen.getByText(/No projects in this program yet/i)).toBeInTheDocument();
  });

  it('renders real projects through the bulk-edit matrix (admin)', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', name: 'Phase 2', my_role: 400 } });
    useProgramProjects.mockReturnValue({
      data: [
        { id: 'pr-1', name: 'Artemis IV', healthState: 'unknown', colorDot: '#3E8C6D', methodology: 'WATERFALL', programId: 'p-1' },
        { id: 'pr-2', name: 'Launch Control', healthState: 'unknown', colorDot: '#3E8C6D', methodology: 'AGILE', programId: 'p-1' },
      ],
      isLoading: false,
      error: null,
    });
    renderPage();
    expect(screen.getByText('Artemis IV')).toBeInTheDocument();
    expect(screen.getByText('Launch Control')).toBeInTheDocument();
    expect(screen.getByText(/2 projects/)).toBeInTheDocument();
    // Admin gets the bulk-edit action bar + per-row selection (issue 1233).
    expect(screen.getByTestId('bulk-fields-action-bar')).toBeInTheDocument();
    expect(screen.getByLabelText('Select Artemis IV')).toBeInTheDocument();
  });

  // #2549: `bulk_project_fields` is gated by IsProgramNotClosed, so an Admin on a
  // closed program must not see the bulk-edit action bar or per-row selection —
  // unlike "+ Add project"/"Import", which assign via a project-level PATCH with
  // no server-side check on the target program's closed state and so stay live.
  it('hides the bulk-edit matrix but keeps Add/Import for an Admin on a closed program', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', name: 'Phase 2', my_role: 400, is_closed: true } });
    useProgramProjects.mockReturnValue({
      data: [
        { id: 'pr-1', name: 'Artemis IV', healthState: 'unknown', colorDot: '#3E8C6D', methodology: 'WATERFALL', programId: 'p-1' },
      ],
      isLoading: false,
      error: null,
    });
    renderPage();
    expect(screen.getByText('Artemis IV')).toBeInTheDocument();
    expect(screen.queryByTestId('bulk-fields-action-bar')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Select Artemis IV')).not.toBeInTheDocument();
    expect(screen.getByText(/bulk field edits are read-only until it's reopened/i)).toBeInTheDocument();
    // Assigning a project to a program is unaffected by program-closed (#2549).
    expect(screen.getByRole('button', { name: /Add project/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Import$/i })).toBeInTheDocument();
  });

  it('hides Add project button for Viewer (Viewer)', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', name: 'Phase 2', my_role: ROLE_VIEWER } });
    useProgramProjects.mockReturnValue({ data: [], isLoading: false, error: null });
    renderPage();
    expect(screen.queryByRole('button', { name: /Add project/i })).not.toBeInTheDocument();
  });

  it('hides Add project button for Member (role=100)', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', name: 'Phase 2', my_role: 100 } });
    useProgramProjects.mockReturnValue({ data: [], isLoading: false, error: null });
    renderPage();
    expect(screen.queryByRole('button', { name: /Add project/i })).not.toBeInTheDocument();
  });

  it('hides Add project button for Scheduler (role=200)', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', name: 'Phase 2', my_role: 200 } });
    useProgramProjects.mockReturnValue({ data: [], isLoading: false, error: null });
    renderPage();
    expect(screen.queryByRole('button', { name: /Add project/i })).not.toBeInTheDocument();
  });

  it('shows Add project button for Admin (role=300)', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', name: 'Phase 2', my_role: 300 } });
    useProgramProjects.mockReturnValue({ data: [], isLoading: false, error: null });
    renderPage();
    expect(screen.getByRole('button', { name: /Add project/i })).toBeInTheDocument();
  });

  it('shows Add project button for Owner (role=400)', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', name: 'Phase 2', my_role: 400 } });
    useProgramProjects.mockReturnValue({ data: [], isLoading: false, error: null });
    renderPage();
    expect(screen.getByRole('button', { name: /Add project/i })).toBeInTheDocument();
  });

  it('does not render the StubPageBanner once wired', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', name: 'Phase 2', my_role: 400 } });
    useProgramProjects.mockReturnValue({ data: [], isLoading: false, error: null });
    renderPage();
    expect(screen.queryByTestId('stub-page-banner')).not.toBeInTheDocument();
  });
});
