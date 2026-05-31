import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import { ProgramProjectsPage } from './ProgramProjectsPage';

const useProgram = vi.fn();
const useProgramProjects = vi.fn();

vi.mock('@/hooks/useProgram', () => ({
  useProgram: () => useProgram() as { data: unknown },
}));

vi.mock('@/hooks/useProgramProjects', () => ({
  useProgramProjects: () =>
    useProgramProjects() as { data: unknown; isLoading: boolean; error: Error | null },
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

  it('renders real projects from the hook', () => {
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
    expect(screen.getByText('WATERFALL')).toBeInTheDocument();
    expect(screen.getByText('AGILE')).toBeInTheDocument();
    expect(screen.getByText(/2 projects/)).toBeInTheDocument();
  });

  it('hides Add project button for Viewer (role=0)', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', name: 'Phase 2', my_role: 0 } });
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
