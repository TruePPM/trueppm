import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, it, expect, vi } from 'vitest';
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
let methodologyOverridePolicy = 'suggest';
let workspaceSettingsState: 'ready' | 'pending' | 'error' = 'ready';
vi.mock('../hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => ({
    data: workspaceSettingsState === 'ready' ? { methodologyOverridePolicy } : undefined,
    isPending: workspaceSettingsState === 'pending',
    isError: workspaceSettingsState === 'error',
  }),
}));
vi.mock('@/hooks/useBulkProjectFields', () => ({
  useBulkProjectFields: () => ({ mutateAsync: vi.fn().mockResolvedValue({ updated: [], fields: [] }), isPending: false }),
}));

// The Add modal renders into a portal and pulls in unrelated mutation hooks; stub it.
vi.mock('@/features/programs/AddProjectToProgramModal', () => ({
  AddProjectToProgramModal: () => <div data-testid="add-modal" />,
}));

function pageTree(queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/programs/p-1/settings/projects']}>
        <Routes>
          <Route path="/programs/:programId/settings/projects" element={<ProgramProjectsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(pageTree(queryClient));
  // Re-render against the same client so a test can change what the mocked hooks
  // return (a refetch landing) without remounting the page.
  return { ...result, refresh: () => { result.rerender(pageTree(queryClient)); } };
}

describe('ProgramProjectsPage (settings)', () => {
  beforeEach(() => {
    methodologyOverridePolicy = 'suggest';
    workspaceSettingsState = 'ready';
  });

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

/**
 * Deviation visibility (#3295). The flag was computed on every row and discarded by
 * `ValueCell`, which annotated only `resettable` fields — and methodology is
 * `resettable: false` by web-rule 196, so it never rendered.
 */
describe('ProgramProjectsPage — deviation from the inherited default (#3295)', () => {
  /** Two deviate from the program's HYBRID; one matches it. */
  const PROJECTS = [
    {
      id: 'pr-1',
      name: 'Artemis IV',
      healthState: 'unknown',
      colorDot: '#3E8C6D',
      methodology: 'WATERFALL',
      effectiveMethodology: 'WATERFALL',
      inheritedMethodology: 'HYBRID',
      programId: 'p-1',
    },
    {
      id: 'pr-2',
      name: 'Launch Control',
      healthState: 'unknown',
      colorDot: '#3E8C6D',
      methodology: 'AGILE',
      effectiveMethodology: 'AGILE',
      inheritedMethodology: 'HYBRID',
      programId: 'p-1',
    },
    {
      id: 'pr-3',
      name: 'Ground Support',
      healthState: 'unknown',
      colorDot: '#3E8C6D',
      methodology: 'HYBRID',
      effectiveMethodology: 'HYBRID',
      inheritedMethodology: 'HYBRID',
      programId: 'p-1',
    },
  ];

  beforeEach(() => {
    methodologyOverridePolicy = 'suggest';
    workspaceSettingsState = 'ready';
    useProgram.mockReturnValue({ data: { id: 'p-1', name: 'Phase 2', my_role: 400 } });
    useProgramProjects.mockReturnValue({ data: PROJECTS, isLoading: false, error: null });
  });

  it('renders the marker on the deviating rows only', () => {
    renderPage();
    const markers = screen.getAllByTestId('deviation-marker-methodology');
    expect(markers).toHaveLength(2);
    expect(markers[0]).toHaveTextContent('Waterfall ≠ program (Hybrid)');
    expect(markers[1]).toHaveTextContent('Agile ≠ program (Hybrid)');
    expect(screen.getByTestId('deviation-count')).toHaveTextContent('2 differ');
  });

  it('mounts MethodologyFilter with a fifth "Deviates from default" option', () => {
    renderPage();
    // It renders on ProgramListPage and AddProjectToProgramModal but was never on
    // this page, which is the surface the scan question is actually asked on.
    const group = screen.getByRole('radiogroup', { name: 'Filter by methodology' });
    expect(within(group).getAllByRole('radio')).toHaveLength(5);
    expect(
      within(group).getByRole('radio', { name: 'Deviates from default, 2' }),
    ).toBeInTheDocument();
  });

  it('narrows the matrix to the deviating cohort and states it in the action bar', () => {
    renderPage();
    const group = screen.getByRole('radiogroup', { name: 'Filter by methodology' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Deviates from default, 2' }));

    expect(screen.getByText('Artemis IV')).toBeInTheDocument();
    expect(screen.queryByText('Ground Support')).not.toBeInTheDocument();
    expect(screen.getByTestId('bulk-fields-scope-note')).toHaveTextContent(
      '2 of 3 shown · Deviates from default',
    );
  });

  it('suppresses the cohort clause when no filter is active', () => {
    renderPage();
    expect(screen.queryByTestId('bulk-fields-scope-note')).not.toBeInTheDocument();
  });

  it('renders a facet matching nothing as an aria-disabled zero, not a bare label', () => {
    useProgramProjects.mockReturnValue({
      data: PROJECTS.filter((p) => p.methodology !== 'AGILE'),
      isLoading: false,
      error: null,
    });
    renderPage();
    const group = screen.getByRole('radiogroup', { name: 'Filter by methodology' });
    const agile = within(group).getByRole('radio', { name: 'Agile, 0' });
    expect(agile).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(agile);
    // Inert — the cohort stands rather than emptying the matrix.
    expect(screen.getByText('Artemis IV')).toBeInTheDocument();
    expect(screen.queryByText('No projects match this filter.')).not.toBeInTheDocument();
  });

  it('states an empty cohort when the rows underneath a live filter go away', () => {
    const { refresh } = renderPage();
    const group = screen.getByRole('radiogroup', { name: 'Filter by methodology' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Waterfall, 1' }));
    expect(screen.getByText('Artemis IV')).toBeInTheDocument();

    // A refetch drops the only Waterfall project while the facet is still selected.
    useProgramProjects.mockReturnValue({
      data: PROJECTS.filter((p) => p.methodology !== 'WATERFALL'),
      isLoading: false,
      error: null,
    });
    refresh();
    expect(
      screen.getByRole('heading', { name: 'No projects match this filter' }),
    ).toBeInTheDocument();
  });

  it('re-parents the label, count and marker to the workspace under an inherit lock', () => {
    methodologyOverridePolicy = 'inherit';
    // Under a lock the server resolves BOTH effective and inherited to the workspace
    // value; the project's own stored value is the unreconciled pre-lock override.
    useProgramProjects.mockReturnValue({
      data: PROJECTS.map((p) => ({ ...p, effectiveMethodology: 'HYBRID' })),
      isLoading: false,
      error: null,
    });
    renderPage();
    const group = screen.getByRole('radiogroup', { name: 'Filter by methodology' });
    expect(
      within(group).getByRole('radio', { name: 'Deviates from workspace, 2' }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId('deviation-marker-methodology')[0]).toHaveTextContent(
      'Waterfall ≠ workspace (Hybrid)',
    );
    // Constraint before count, and the column stays: a lock makes the unreconciled
    // rows more interesting, not less.
    expect(screen.getByTestId('bulk-fields-header')).toHaveTextContent(
      'Methodology · read-only · 2 differ',
    );
    // Under a lock the cell prints the row's OWN value, so the facets must bucket on
    // that too — otherwise `effectiveMethodology` (the workspace value on every row)
    // collapses them into one and puts "Waterfall 0" above a visible Waterfall cell.
    expect(within(group).getByRole('radio', { name: 'Waterfall, 1' })).not.toHaveAttribute(
      'aria-disabled',
    );
    fireEvent.click(within(group).getByRole('radio', { name: 'Waterfall, 1' }));
    expect(screen.getByText('Artemis IV')).toBeInTheDocument();
    expect(screen.queryByText('Ground Support')).not.toBeInTheDocument();
  });

  it('omits the fifth option, markers and count when no row carries an inherited value', () => {
    useProgramProjects.mockReturnValue({
      data: PROJECTS.map(({ inheritedMethodology: _drop, ...p }) => p),
      isLoading: false,
      error: null,
    });
    renderPage();
    const group = screen.getByRole('radiogroup', { name: 'Filter by methodology' });
    expect(within(group).getAllByRole('radio')).toHaveLength(4);
    expect(screen.queryByTestId('deviation-marker-methodology')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deviation-count')).not.toBeInTheDocument();
  });

  it('says nothing about deviation until the workspace policy resolves', () => {
    // `resolve_inherited_methodology` re-parents to the workspace under a lock, so with
    // the policy unknown "≠ program" would be a positively false claim.
    workspaceSettingsState = 'pending';
    renderPage();
    expect(screen.queryByTestId('deviation-marker-methodology')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deviation-count')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('radiogroup', { name: 'Filter by methodology' })).getAllByRole(
        'radio',
      ),
    ).toHaveLength(4);
  });

  it('stays silent rather than guessing when the workspace query fails outright', () => {
    workspaceSettingsState = 'error';
    renderPage();
    expect(screen.queryByTestId('deviation-marker-methodology')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deviation-count')).not.toBeInTheDocument();
  });

  it('falls back to All when a live selection stops being offered', () => {
    const { refresh } = renderPage();
    const group = screen.getByRole('radiogroup', { name: 'Filter by methodology' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Deviates from default, 2' }));
    expect(screen.queryByText('Ground Support')).not.toBeInTheDocument();

    // A refetch drops the inherited value, so the fifth option goes. Leaving the value
    // in place would strand the radiogroup with nothing checked — and, because
    // `tabIndex` is roving, with no tabbable option at all — while the rows stay
    // narrowed by a control the user can no longer see.
    useProgramProjects.mockReturnValue({
      data: PROJECTS.map(({ inheritedMethodology: _drop, ...p }) => p),
      isLoading: false,
      error: null,
    });
    refresh();

    const after = screen.getByRole('radiogroup', { name: 'Filter by methodology' });
    expect(within(after).getByRole('radio', { name: 'All, 3' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText('Ground Support')).toBeInTheDocument();
  });

  it('falls back to All when the viewport collapses the facet that was selected', () => {
    // The 768px crossing is the other way the selected option can stop existing, and
    // it is the path that produced the stale-roving-index bug: with `focusIdx` past
    // the new end, EVERY option evaluates tabIndex -1 and the filter leaves the tab
    // order while the rows stay narrowed.
    const { refresh } = renderPage();
    const group = screen.getByRole('radiogroup', { name: 'Filter by methodology' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Waterfall, 1' }));
    expect(screen.queryByText('Launch Control')).not.toBeInTheDocument();

    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    refresh();

    const collapsed = screen.getByRole('radiogroup', { name: 'Filter by methodology' });
    const radios = within(collapsed).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radios.some((r) => r.getAttribute('tabindex') === '0')).toBe(true);
    expect(within(collapsed).getByRole('radio', { name: 'All, 3' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText('Launch Control')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('keeps the zero option readable — no opacity multiplier, no hover lie', () => {
    useProgramProjects.mockReturnValue({
      data: PROJECTS.filter((p) => p.methodology !== 'AGILE'),
      isLoading: false,
      error: null,
    });
    renderPage();
    const agile = within(
      screen.getByRole('radiogroup', { name: 'Filter by methodology' }),
    ).getByRole('radio', { name: 'Agile, 0' });
    // Its whole job is to be read: half-opacity secondary text fails WCAG 1.4.3.
    expect(agile.className).not.toMatch(/opacity-/);
    expect(agile.className).not.toContain('hover:bg-neutral-surface-raised');
    expect(agile.className).toContain('cursor-not-allowed');
  });

  it('renders the whole read layer for a Viewer — markers, count and filter are reads', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', name: 'Phase 2', my_role: ROLE_VIEWER } });
    renderPage();
    expect(screen.queryByTestId('bulk-fields-action-bar')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('deviation-marker-methodology')).toHaveLength(2);
    expect(screen.getByTestId('deviation-count')).toHaveTextContent('2 differ');
    expect(
      screen.getByRole('radiogroup', { name: 'Filter by methodology' }),
    ).toBeInTheDocument();
  });

  it('still states the cohort to a reader who has no action bar to carry it', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', name: 'Phase 2', my_role: ROLE_VIEWER } });
    renderPage();
    const group = screen.getByRole('radiogroup', { name: 'Filter by methodology' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Deviates from default, 2' }));
    // Read context must not be stranded behind the write gate — scanning is a
    // Viewer's only affordance here, so the count of what was narrowed away is
    // exactly what they need.
    expect(screen.getByTestId('bulk-fields-scope-note')).toHaveTextContent(
      '2 of 3 shown · Deviates from default',
    );
  });

  it('renders the read layer for an Admin on a CLOSED program', () => {
    useProgram.mockReturnValue({
      data: { id: 'p-1', name: 'Phase 2', my_role: 400, is_closed: true },
    });
    renderPage();
    expect(screen.queryByTestId('bulk-fields-action-bar')).not.toBeInTheDocument();
    expect(screen.getByTestId('deviation-count')).toHaveTextContent('2 differ');
    expect(
      screen.getByRole('radiogroup', { name: 'Filter by methodology' }),
    ).toBeInTheDocument();
  });

  it('clears a live selection when the cohort changes, and announces it (D13)', () => {
    const { container } = renderPage();
    fireEvent.click(screen.getByLabelText<HTMLInputElement>('Select Artemis IV'));
    expect(screen.getByLabelText<HTMLInputElement>('Select Artemis IV').checked).toBe(true);

    const group = screen.getByRole('radiogroup', { name: 'Filter by methodology' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Deviates from default, 2' }));

    expect(screen.getByLabelText<HTMLInputElement>('Select Artemis IV').checked).toBe(false);
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent(
      'Selection cleared. Showing 2 projects.',
    );
  });
});
