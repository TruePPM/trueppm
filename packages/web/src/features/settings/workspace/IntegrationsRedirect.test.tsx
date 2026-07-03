import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntegrationsRedirect } from './IntegrationsRedirect';

const useProjects = vi.fn();

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () =>
    useProjects() as { data: unknown; isLoading: boolean; error: Error | null },
}));

// Mocked the same way Sidebar.test.tsx mocks NewProjectModal — the modal's
// own create flow is covered by NewProjectModal's own tests; here we only
// need to assert the shim wires the button to opening it.
vi.mock('@/features/shell/NewProjectModal', () => ({
  NewProjectModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="new-project-modal">
      <button onClick={onClose}>close-modal</button>
    </div>
  ),
}));

function renderShim() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/settings/integrations']}>
        <Routes>
          <Route path="/settings/integrations" element={<IntegrationsRedirect />} />
          <Route
            path="/projects/:projectId/settings/integrations"
            element={<div data-testid="project-target">project-page</div>}
          />
          <Route path="/projects/new" element={<div data-testid="new-project">new</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useProjects.mockReset();
});

describe('IntegrationsRedirect', () => {
  it('renders empty state when the user has zero projects', () => {
    useProjects.mockReturnValue({ data: [], isLoading: false, error: null });
    renderShim();
    expect(
      screen.getByText(/Integrations are configured per project/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Create your first project/i }),
    ).toBeInTheDocument();
  });

  it('opens the New Project modal when "Create your first project" is clicked', async () => {
    useProjects.mockReturnValue({ data: [], isLoading: false, error: null });
    renderShim();
    expect(screen.queryByTestId('new-project-modal')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Create your first project/i }));
    expect(screen.getByTestId('new-project-modal')).toBeInTheDocument();
  });

  it('auto-redirects to the only project when the user has exactly one', async () => {
    useProjects.mockReturnValue({
      data: [
        {
          id: 'p-1',
          name: 'Helios firmware',
          healthState: 'unknown',
          colorDot: '#3E8C6D',
          methodology: 'HYBRID',
          programId: null,
        },
      ],
      isLoading: false,
      error: null,
    });
    renderShim();
    await waitFor(() => {
      expect(screen.getByTestId('project-target')).toBeInTheDocument();
    });
  });

  it('renders the project picker when the user has two or more projects', () => {
    useProjects.mockReturnValue({
      data: [
        { id: 'p-1', name: 'Helios firmware', healthState: 'unknown', colorDot: '#3E8C6D', methodology: 'HYBRID', programId: null },
        { id: 'p-2', name: 'Platform migration', healthState: 'unknown', colorDot: '#E8A020', methodology: 'AGILE', programId: null },
      ],
      isLoading: false,
      error: null,
    });
    renderShim();
    expect(screen.getByText(/Which project.s integrations/i)).toBeInTheDocument();
    expect(screen.getByText('Helios firmware')).toBeInTheDocument();
    expect(screen.getByText('Platform migration')).toBeInTheDocument();
    // Both rows are accessible links, never just text, so keyboard users can
    // tab into the picker.
    expect(
      screen.getByRole('link', { name: /Helios firmware/ }),
    ).toBeInTheDocument();
  });

  it('renders a loading skeleton while projects are fetching', () => {
    useProjects.mockReturnValue({ data: undefined, isLoading: true, error: null });
    const { container } = renderShim();
    // The skeleton is a bare pulse-animation div; assert the container is not
    // showing the picker/empty-state copy.
    expect(container.querySelector('[class*="animate-pulse"]')).not.toBeNull();
    expect(screen.queryByText(/Which project.s integrations/i)).toBeNull();
    expect(
      screen.queryByText(/Integrations are configured per project/i),
    ).toBeNull();
  });
});
