import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Program } from '@/api/types';
import { ProgramListPage } from './ProgramListPage';

const usePrograms = vi.fn();
const useUngroupedProjects = vi.fn();

vi.mock('@/hooks/usePrograms', () => ({
  usePrograms: () => usePrograms() as { data: unknown; isLoading: boolean; error: Error | null },
}));

// ProgramListPage renders <UngroupedProjectsSection/>, which calls this hook.
// Mock it so the page stays isolated; default to "no ungrouped projects" so the
// section self-hides and existing assertions are unaffected.
vi.mock('@/hooks/useUngroupedProjects', () => ({
  useUngroupedProjects: () =>
    useUngroupedProjects() as { data: unknown; isLoading: boolean; error: Error | null },
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
    effective_methodology: 'HYBRID',
    inherited_methodology: 'HYBRID',
    iteration_label: null,
    inherited_iteration_label: 'Sprint',
    public_sharing: null,
    allow_guests: null,
    effective_public_sharing: false,
    effective_allow_guests: true,
    inherited_public_sharing: false,
    inherited_allow_guests: true,
    mc_history_enabled: null,
    mc_history_retention_cap: null,
    mc_history_attribution_audience: null,
    effective_mc_history_enabled: true,
    effective_mc_history_retention_cap: 100,
    effective_mc_history_attribution_audience: 'ADMIN_OWNER',
    inherited_mc_history_enabled: true,
    inherited_mc_history_retention_cap: 100,
    inherited_mc_history_attribution_audience: 'ADMIN_OWNER',
    attachments_enabled: null,
    allowed_attachment_types: null,
    effective_attachments_enabled: true,
    effective_allowed_attachment_types: ['application/pdf'],
    inherited_attachments_enabled: true,
    inherited_allowed_attachment_types: ['application/pdf'],
    health: 'AUTO',
    visibility: 'WORKSPACE',
    color: null,
    lead: null,
    lead_detail: null,
    created_by: 'u-1',
    created_at: '2026-05-18T00:00:00Z',
    updated_at: '2026-05-18T00:00:00Z',
    my_role: 400,
    my_role_label: 'Project Admin',
    project_count: 3,
    member_count: 5,
    is_sample: false,
    is_closed: false,
    closed_at: null,
    closed_by: null,
    ...overrides,
  };
}

describe('ProgramListPage', () => {
  beforeEach(() => {
    // Default: no ungrouped projects, so the section self-hides.
    useUngroupedProjects.mockReturnValue({ data: [], isLoading: false, error: null });
  });

  it('renders hero empty state when no programs', () => {
    usePrograms.mockReturnValue({ data: [], isLoading: false, error: null });
    renderPage();
    expect(screen.getByText(/Programs group related projects/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create your first program/i })).toBeInTheDocument();
  });

  it('offers an Import from JSON affordance in the empty state', () => {
    usePrograms.mockReturnValue({ data: [], isLoading: false, error: null });
    renderPage();
    // header + hero both expose the import button
    expect(screen.getAllByRole('button', { name: /Import from JSON/i }).length).toBeGreaterThan(0);
  });

  it('offers a Load demo data affordance in the empty state', () => {
    usePrograms.mockReturnValue({ data: [], isLoading: false, error: null });
    renderPage();
    // header + hero both expose the demo loader
    expect(screen.getAllByRole('button', { name: /Load demo data/i }).length).toBeGreaterThan(0);
  });

  it('offers an Import from JSON affordance in the header when programs exist', () => {
    usePrograms.mockReturnValue({
      data: [makeProgram({ id: 'p-1', name: 'Phase 2' })],
      isLoading: false,
      error: null,
    });
    renderPage();
    expect(screen.getByRole('button', { name: /Import from JSON/i })).toBeInTheDocument();
  });

  it('offers a Load demo data affordance in the header when programs exist', () => {
    // The demo loader must stay reachable on a populated instance, not only in
    // the zero-programs empty state (the hero is not rendered here).
    usePrograms.mockReturnValue({
      data: [makeProgram({ id: 'p-1', name: 'Phase 2' })],
      isLoading: false,
      error: null,
    });
    renderPage();
    expect(screen.getByRole('button', { name: /Load demo data/i })).toBeInTheDocument();
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

  it('renders the ungrouped-projects section when standalone projects exist', () => {
    usePrograms.mockReturnValue({
      data: [makeProgram({ id: 'p-1', name: 'Phase 2' })],
      isLoading: false,
      error: null,
    });
    useUngroupedProjects.mockReturnValue({
      data: [
        {
          id: 'pr-1',
          name: 'Neptune Cryo Rig',
          code: 'NEP',
          healthState: 'on-track',
          percentComplete: 38,
          memberCount: 4,
        },
      ],
      isLoading: false,
      error: null,
    });
    renderPage();
    expect(screen.getByRole('heading', { name: /Ungrouped projects/i })).toBeInTheDocument();
    expect(screen.getByText('1 need a home')).toBeInTheDocument();
    expect(screen.getByText('Neptune Cryo Rig')).toBeInTheDocument();
  });
});
