import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectGeneralPage } from './ProjectGeneralPage';

const useProjectId = vi.fn();
const useProject = vi.fn();
const useUpdateProject = vi.fn();

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => useProjectId() as string | undefined,
}));

vi.mock('@/hooks/useProject', () => ({
  useProject: (projectId: string | undefined) =>
    useProject(projectId) as { data: unknown },
}));

vi.mock('@/hooks/useProjectMutations', () => ({
  useUpdateProject: (projectId: string | undefined) =>
    useUpdateProject(projectId) as { mutateAsync: (payload: unknown) => Promise<unknown> },
}));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/p-1/settings/general']}>
        <Routes>
          <Route path="/projects/:projectId/settings/general" element={<ProjectGeneralPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const SEED_PROJECT = {
  id: 'p-1',
  server_version: 1,
  name: 'Atlas Migration',
  description: 'Migrate the data warehouse to the new platform.',
  start_date: '2026-01-01',
  calendar: 'default',
  estimation_mode: 'hours',
  agile_features: false,
  methodology: 'HYBRID',
};

beforeEach(() => {
  useProjectId.mockReturnValue('p-1');
  useProject.mockReturnValue({ data: SEED_PROJECT });
  useUpdateProject.mockReturnValue({ mutateAsync: vi.fn() });
});

describe('ProjectGeneralPage', () => {
  it('seeds Name and Description from the project record and keeps them editable', () => {
    renderPage();

    const name = screen.getByRole('textbox', { name: /project name/i });
    expect(name).toHaveValue('Atlas Migration');
    expect(name).not.toBeDisabled();

    const desc = screen.getByRole('textbox', { name: /description/i });
    expect(desc).toHaveValue('Migrate the data warehouse to the new platform.');
    expect(desc).not.toBeDisabled();
  });

  // Reason: #591 — without this notice the mixed live/disabled state is more
  // confusing than a fully-stubbed page would be (Sarah's "At risk" click goes
  // nowhere and she can't tell whether it's broken, hidden, or unimplemented).
  it('renders the extended-fields stub notice linking to #520', () => {
    renderPage();

    const notice = screen.getByTestId('project-general-extended-stub-notice');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent(/the fields below ship with/i);
    expect(notice).toHaveTextContent(/saved yet/i);

    const link = within(notice).getByRole('link', { name: '#520' });
    expect(link).toHaveAttribute('href', 'https://gitlab.com/trueppm/trueppm/-/issues/520');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders extended fields as disabled (pending #520)', () => {
    renderPage();

    // Health buttons are disabled until #520 wires the serializer.
    const healthButtons = screen.getAllByRole('button', { name: /(on track|at risk|critical|auto)/i });
    expect(healthButtons.length).toBeGreaterThan(0);
    healthButtons.forEach((btn) => expect(btn).toBeDisabled());

    // Default-view select uses a combobox role.
    const selects = screen.getAllByRole('combobox');
    selects.forEach((s) => expect(s).toBeDisabled());
  });
});
