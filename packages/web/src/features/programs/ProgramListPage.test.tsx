import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Program } from '@/api/types';
import { ProgramListPage } from './ProgramListPage';
import { ROLE_VIEWER } from '@/lib/roles';

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
    is_pinned: false,
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
    effective_mc_history_attribution_audience: 'admin_owner',
    inherited_mc_history_enabled: true,
    inherited_mc_history_retention_cap: 100,
    inherited_mc_history_attribution_audience: 'admin_owner',
    task_duration_change_percent_policy: null,
    effective_task_duration_change_percent_policy: 'keep',
    inherited_task_duration_change_percent_policy: 'keep',
    estimation_scale: null,
    effective_estimation_scale: 'fibonacci',
    inherited_estimation_scale: 'fibonacci',
    sprint_picker_ready_only_default: null,
    effective_sprint_picker_ready_only_default: true,
    inherited_sprint_picker_ready_only_default: true,
    attachments_enabled: null,
    allowed_attachment_types: null,
    effective_attachments_enabled: true,
    effective_allowed_attachment_types: ['application/pdf'],
    inherited_attachments_enabled: true,
    inherited_allowed_attachment_types: ['application/pdf'],
    mcp_enabled: null,
    effective_mcp_enabled: true,
    inherited_mcp_enabled: true,
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

  it('renders the shared retryable error state when the query fails (#2176)', async () => {
    const refetch = vi.fn();
    usePrograms.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
      refetch,
    });
    renderPage();
    const alert = screen.getByRole('status');
    expect(alert).toHaveTextContent(/Couldn't load programs/i);
    await userEvent.click(within(alert).getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders a card per program with counts and role chip', () => {
    usePrograms.mockReturnValue({
      data: [
        makeProgram({ id: 'p-1', name: 'Phase 2', project_count: 4, member_count: 7 }),
        makeProgram({ id: 'p-2', name: 'Customer Health', my_role: ROLE_VIEWER, my_role_label: 'Viewer' }),
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

      // Scope to the empty-state block — the search box also exposes a "Clear
      // filter" affordance while a query is active. Scoped by testid since
      // #3198: the block no longer carries a role of its own (ADR-0989).
      const emptyState = screen.getByTestId('empty-state');
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

  describe('pinned grouping (#2390, design §5.2)', () => {
    const PINNED_CHARLIE = [
      makeProgram({ id: 'a', name: 'Alpha' }),
      makeProgram({ id: 'b', name: 'Bravo' }),
      makeProgram({ id: 'c', name: 'Charlie', is_pinned: true }),
    ];

    /** Like `renderPage`, but keeps the tree so a test can re-render with new data. */
    function renderResortable(data: Program[]) {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      // A FRESH element each time — re-rendering the identical element object
      // lets React bail out and the new mock data never reaches the page.
      const tree = () => (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <ProgramListPage />
          </MemoryRouter>
        </QueryClientProvider>
      );
      usePrograms.mockReturnValue({ data, isLoading: false, error: null });
      const view = render(tree());
      return {
        ...view,
        // Re-render the SAME mounted page with a new program list, which is what
        // an optimistic pin patch looks like from this component's perspective.
        update(next: Program[]) {
          usePrograms.mockReturnValue({ data: next, isLoading: false, error: null });
          view.rerender(tree());
        },
      };
    }

    it('lifts pins into a labelled group above everything else', () => {
      usePrograms.mockReturnValue({ data: PINNED_CHARLIE, isLoading: false, error: null });
      renderPage();

      // The heading carries the count AND restates that the chosen sort still
      // applies inside it — without that, a card out of date order under a
      // control reading "Recently active" looks like a broken sort.
      expect(screen.getByRole('heading', { name: /Pinned · 1/ })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /Everything else · 2/ })).toBeInTheDocument();
      expect(screen.getAllByText(/sorted by recently active, like everything else/i)).toHaveLength(
        2,
      );
      // Headings are presentational <li>s, so the list still counts 3 programs.
      const grid = screen.getByRole('list', { name: 'Programs' });
      expect(within(grid).getAllByRole('listitem')).toHaveLength(3);
    });

    it('shows no groups when nothing is pinned — an "Everything else" alone explains nothing', () => {
      usePrograms.mockReturnValue({
        data: [makeProgram({ id: 'a', name: 'Alpha' })],
        isLoading: false,
        error: null,
      });
      renderPage();
      expect(screen.queryByRole('heading', { name: /Everything else/ })).not.toBeInTheDocument();
    });

    it('flattens to one honest list when "Pinned first" is switched off', async () => {
      const user = userEvent.setup();
      usePrograms.mockReturnValue({ data: PINNED_CHARLIE, isLoading: false, error: null });
      renderPage();

      await user.click(screen.getByRole('checkbox', { name: /Pinned first/i }));

      expect(screen.queryByRole('heading', { name: /Pinned · / })).not.toBeInTheDocument();
      // Pure sort order — Charlie returns to its alphabetical place, keeping its glyph.
      const names = within(screen.getByRole('list', { name: 'Programs' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent);
      expect(names[0]).toContain('Alpha');
      expect(names[2]).toContain('Charlie');
      expect(localStorage.getItem('trueppm.programs.pinnedFirst')).toBe('false');
    });

    it('flattens the groups while searching, so pins never outrank relevance', async () => {
      const user = userEvent.setup();
      usePrograms.mockReturnValue({ data: PINNED_CHARLIE, isLoading: false, error: null });
      renderPage();
      expect(screen.getByRole('heading', { name: /Pinned · 1/ })).toBeInTheDocument();

      await user.type(screen.getByRole('searchbox', { name: /Filter programs by name/i }), 'a');
      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: /Pinned · / })).not.toBeInTheDocument(),
      );
    });

    it('defers the move — a freshly-pinned card holds its place', () => {
      const view = renderResortable([
        makeProgram({ id: 'a', name: 'Alpha' }),
        makeProgram({ id: 'b', name: 'Bravo' }),
      ]);
      // Nothing pinned yet, so no groups.
      expect(screen.queryByRole('heading', { name: /Pinned · / })).not.toBeInTheDocument();

      // Bravo is now pinned (the optimistic patch has landed).
      view.update([
        makeProgram({ id: 'a', name: 'Alpha' }),
        makeProgram({ id: 'b', name: 'Bravo', is_pinned: true }),
      ]);

      // The card is marked, but it has NOT jumped into a Pinned group — a row
      // that leaps out from under the cursor causes the next mis-click. The move
      // lands on the next visit, or on the toast's "Re-sort now".
      expect(screen.queryByRole('heading', { name: /Pinned · / })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Unpin Bravo' })).toBeInTheDocument();
    });
  });
});
