import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    calendar: null,
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
    task_duration_change_percent_policy: null,
    effective_task_duration_change_percent_policy: 'keep',
    inherited_task_duration_change_percent_policy: 'keep',
    attachments_enabled: null,
    allowed_attachment_types: null,
    effective_attachments_enabled: true,
    effective_allowed_attachment_types: ['application/pdf'],
    inherited_attachments_enabled: true,
    inherited_allowed_attachment_types: ['application/pdf'],
    risk_slip_propagation: 'warn',
    risk_escalation_days: 3,
    health: 'AUTO',
    target_date: null,
    visibility: 'WORKSPACE',
    color: null,
    lead: null,
    lead_detail: null,
    created_by: 'u-1',
    created_at: '2026-05-18T00:00:00Z',
    updated_at: '2026-05-18T00:00:00Z',
    my_role: 400,
    my_role_label: 'Program Admin',
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
    localStorage.clear();
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

  describe('filter / sort toolbar (#1796)', () => {
    const THREE = [
      makeProgram({ id: 'a', name: 'Alpha', methodology: 'WATERFALL' }),
      makeProgram({ id: 'b', name: 'Bravo', methodology: 'AGILE' }),
      makeProgram({ id: 'c', name: 'Charlie', methodology: 'HYBRID' }),
    ];

    it('narrows the cards as the filter is typed', async () => {
      const user = userEvent.setup();
      usePrograms.mockReturnValue({ data: THREE, isLoading: false, error: null });
      renderPage();

      const grid = screen.getByRole('list', { name: 'Programs' });
      expect(within(grid).getAllByRole('listitem')).toHaveLength(3);

      await user.type(screen.getByRole('searchbox', { name: /Filter programs by name/i }), 'brav');
      // The filter commit is debounced — wait for the grid to narrow.
      await waitFor(() =>
        expect(
          within(screen.getByRole('list', { name: 'Programs' })).getAllByRole('listitem'),
        ).toHaveLength(1),
      );
      expect(screen.getByText('Bravo')).toBeInTheDocument();
      expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    });

    it('shows the empty-filter-result state with a Clear filter action', async () => {
      const user = userEvent.setup();
      usePrograms.mockReturnValue({ data: THREE, isLoading: false, error: null });
      renderPage();

      await user.type(
        screen.getByRole('searchbox', { name: /Filter programs by name/i }),
        'nonexistent',
      );
      expect(await screen.findByText(/No programs match your filter/i)).toBeInTheDocument();

      // Scope to the empty-state status region — the search box also exposes a
      // "Clear filter" affordance while a query is active.
      const emptyState = screen.getByRole('status');
      await user.click(within(emptyState).getByRole('button', { name: /Clear filter/i }));
      expect(screen.getByRole('list', { name: 'Programs' })).toBeInTheDocument();
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    it('persists the sort choice to localStorage', async () => {
      const user = userEvent.setup();
      usePrograms.mockReturnValue({ data: THREE, isLoading: false, error: null });
      renderPage();

      await user.selectOptions(
        screen.getByRole('combobox', { name: /Sort/i }),
        'Health (worst first)',
      );
      expect(localStorage.getItem('trueppm.programs.sort')).toBe('health');
    });
  });
});
