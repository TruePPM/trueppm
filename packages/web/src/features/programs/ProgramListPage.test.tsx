import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import type { Program } from '@/api/types';
import { ProgramListPage } from './ProgramListPage';

const usePrograms = vi.fn();

vi.mock('@/hooks/usePrograms', () => ({
  usePrograms: () => usePrograms() as { data: unknown; isLoading: boolean; error: Error | null },
}));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ProgramListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 'p-1',
    server_version: 1,
    name: 'Phase 2',
    description: 'Q3 rebuild',
    code: '',
    methodology: 'HYBRID',
    health: 'AUTO',
    visibility: 'WORKSPACE',
    lead: null,
    lead_detail: null,
    created_by: 'u-1',
    created_at: '2026-05-18T00:00:00Z',
    updated_at: '2026-05-18T00:00:00Z',
    my_role: 400,
    my_role_label: 'Project Admin',
    project_count: 3,
    member_count: 5,
    ...overrides,
  };
}

describe('ProgramListPage', () => {
  it('renders hero empty state when no programs', () => {
    usePrograms.mockReturnValue({ data: [], isLoading: false, error: null });
    renderPage();
    expect(screen.getByText(/Programs group related projects/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Create your first program/i }),
    ).toBeInTheDocument();
  });

  it('renders skeletons while loading', () => {
    usePrograms.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderPage();
    expect(screen.getByLabelText(/Loading programs/i)).toBeInTheDocument();
  });

  it('renders error state when query fails', () => {
    usePrograms.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
    });
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(/Failed to load programs/i);
  });

  it('renders a card per program with counts and role chip', () => {
    usePrograms.mockReturnValue({
      data: [
        makeProgram({ id: 'p-1', name: 'Phase 2', project_count: 4, member_count: 7 }),
        makeProgram({ id: 'p-2', name: 'Customer Health', my_role: 0, my_role_label: 'Viewer' }),
      ],
      isLoading: false,
      error: null,
    });
    renderPage();
    expect(screen.getByText('Phase 2')).toBeInTheDocument();
    expect(screen.getByText(/4 projects · 7 members · HYBRID/)).toBeInTheDocument();
    expect(screen.getByText('Customer Health')).toBeInTheDocument();
    expect(screen.getByText('Viewer')).toBeInTheDocument();
  });
});
