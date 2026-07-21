import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// RiskRegisterView reads `?severity=high` via useSearchParams (#1691), so it
// needs a Router in the tree — use the router-wrapping render helper.
import { renderWithProvidersAndRouter as renderWithProviders } from '@/test/utils';
import type { Risk } from '@/api/types';

const FIXTURE_RISK: Risk = {
  id: 'risk-001',
  short_id: '1',
  short_id_display: 'R-001',
  qualified_id: 'PLAT-R-001',
  server_version: 1,
  project: 'p1',
  title: 'Critical infrastructure failure',
  description: 'Infra may fail',
  status: 'OPEN',
  probability: 5,
  impact: 5,
  severity: 25,
  owner: null,
  owner_name: null,
  owner_initials: null,
  created_by: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  tasks: [],
  category: 'TECHNICAL',
  response: 'MITIGATE',
  mitigation_due_date: null,
  trigger: '',
  contingency: '',
  notes: '',
};

const HIGH_RISK: Risk = {
  ...FIXTURE_RISK,
  id: 'risk-002',
  short_id: '2',
  short_id_display: 'R-002',
  qualified_id: 'PLAT-R-002',
  title: 'Vendor delay',
  probability: 4,
  impact: 4,
  severity: 16,
};

// State controlled per-test via beforeEach so the same module mock can simulate
// loading / error / empty / no-project paths without re-importing.
const useProjectIdState = { value: 'p1' as string | null };
const useRisksState = {
  risks: [FIXTURE_RISK] as Risk[],
  isLoading: false as boolean,
  error: null as Error | null,
};

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => useProjectIdState.value,
}));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({ data: [{ id: 'p1', name: 'Test Project' }] }),
}));

const currentUserState = { id: 'user-1' as string | null };
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: currentUserState.id ? { id: currentUserState.id } : undefined,
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useRisks', () => ({
  useRisks: () => useRisksState,
  useCreateRisk: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useUpdateRisk: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDeleteRisk: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useRiskComments: () => ({ comments: [], isLoading: false }),
  useCreateRiskComment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

// Risk write gate (Member+, issue 223). Defaults to `null` (role loading /
// Viewer) so the Import affordance is hidden — matching the un-mocked behavior
// the earlier tests were written against — and is flipped per-test to exercise
// the canImport=true branch (Import button, empty-state Import, mobile menuitem).
const roleState = { value: null as number | null };
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: roleState.value, roleLabel: null, isLoading: false }),
}));

// Spy the CSV exporter so we can assert the Export action fires with the
// currently-displayed rows without triggering a real jsdom blob download.
const exportRisksToCSVMock = vi.fn<(risks: unknown[], projectSlug: string) => void>();
vi.mock('./riskExport', () => ({
  exportRisksToCSV: exportRisksToCSVMock,
}));

// Stub the import modal at the module boundary — the register only owns its
// open/close trigger; the modal's own upload state machine is tested elsewhere.
vi.mock('./RiskImportModal', () => ({
  RiskImportModal: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Import risks from CSV">
      <button type="button" onClick={onClose}>
        Close import
      </button>
    </div>
  ),
}));

// Mock the heavy children at the module boundary. The structural assertion is
// about RiskRegisterView's JSX placement — does it render the drawer *inside*
// the two-column flex parent? — which is independent of what the drawer itself
// renders. Mocking also keeps these low-coverage files out of the report
// denominator (vitest config has `coverage.all: false`); a vitest test that
// imports the entire risk subtree just to assert a layout invariant would
// otherwise drag global branch coverage below the 78% threshold.
vi.mock('./RiskDrawer', () => ({
  RiskDrawer: ({ risk }: { risk: Risk | null }) => (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={risk?.title ?? 'New risk'}
      className="hidden md:flex w-[480px] shrink-0 flex-col"
    >
      drawer
    </div>
  ),
}));

vi.mock('./RiskMatrix', () => ({
  RiskMatrix: () => <div data-testid="risk-matrix" />,
}));

vi.mock('./RiskChip', () => ({
  RiskChip: ({ severity }: { severity: number }) => <span>sev:{severity}</span>,
}));

// Imported after the mocks above so the real RiskRegisterView module wires
// against the stubs rather than loading the full child subtree.
const { RiskRegisterView } = await import('./RiskRegisterView');

describe('RiskRegisterView', () => {
  beforeEach(() => {
    useProjectIdState.value = 'p1';
    useRisksState.risks = [FIXTURE_RISK];
    useRisksState.isLoading = false;
    useRisksState.error = null;
    currentUserState.id = 'user-1';
    roleState.value = null;
    exportRisksToCSVMock.mockClear();
    localStorage.clear();
  });

  it('renders the drawer as a sibling of the table column inside the two-column flex container (issue #293)', () => {
    renderWithProviders(<RiskRegisterView />);

    const row = screen.getByRole('button', { name: /Open risk: Critical infrastructure failure/ });
    fireEvent.click(row);

    // The drawer mock renders a single dialog with the desktop md:flex variant.
    const desktopDialog = screen.getByRole('dialog', { name: 'Critical infrastructure failure' });
    expect(desktopDialog.className).toMatch(/md:flex/);

    const table = screen.getByRole('table');
    const tableColumn = table.closest('div.flex-1.min-w-0');
    expect(tableColumn, 'table column wrapper should exist').not.toBeNull();

    // The bug: drawer was rendered outside the two-column flex parent, so it
    // stacked below the page content. The fix puts it inside, as a flex sibling
    // of the table column. Verify they share the same direct parent.
    expect(desktopDialog.parentElement).toBe(tableColumn!.parentElement);

    // And that shared parent must be the two-column flex row container
    expect(tableColumn!.parentElement?.className).toMatch(/\bflex\b/);
    expect(tableColumn!.parentElement?.className).toMatch(/gap-4/);
  });

  it('renders the server-formatted risk id verbatim (#929 — no client-side hex parsing)', () => {
    // Regression guard for the R-0000 collapse: the register must render the
    // server's short_id_display, not re-derive an id from the raw short_id.
    renderWithProviders(<RiskRegisterView />);
    expect(screen.getByText('R-001')).toBeInTheDocument();
  });

  it('shows the project-picker placeholder when no project is selected', () => {
    useProjectIdState.value = null;
    renderWithProviders(<RiskRegisterView />);
    expect(screen.getByText('Select a project to view risks.')).toBeInTheDocument();
  });

  it('opens the drawer on the risk named by ?risk= so an activity/register deep-link lands on the item (#2046)', async () => {
    renderWithProviders(<RiskRegisterView />, { initialEntries: ['/?risk=risk-001'] });
    expect(
      await screen.findByRole('dialog', { name: 'Critical infrastructure failure' }),
    ).toBeInTheDocument();
  });

  it('renders skeleton rows while risks are loading', () => {
    useRisksState.risks = [];
    useRisksState.isLoading = true;
    renderWithProviders(<RiskRegisterView />);
    expect(screen.getByLabelText('Loading risks')).toBeInTheDocument();
  });

  it('renders an error alert with a retry button when the risks query fails', () => {
    useRisksState.risks = [];
    useRisksState.error = new Error('boom');
    renderWithProviders(<RiskRegisterView />);
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load risks.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows the empty-state CTA when no risks exist', () => {
    useRisksState.risks = [];
    renderWithProviders(<RiskRegisterView />);
    expect(screen.getByText('No risks yet')).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: '+ Add your first risk' });
    fireEvent.click(cta);
    // Clicking the CTA opens the drawer in create mode (risk = null).
    expect(screen.getByRole('dialog', { name: 'New risk' })).toBeInTheDocument();
  });

  it('opens the mobile overflow menu when the More actions button is clicked', () => {
    renderWithProviders(<RiskRegisterView />);
    const trigger = screen.getByRole('button', { name: 'More actions' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitem', { name: 'Export CSV' })).toBeInTheDocument();
  });

  it('toggles the heatmap aside when the Heatmap button is pressed', () => {
    renderWithProviders(<RiskRegisterView />);
    const heatmapToggle = screen.getByRole('button', { name: /Heatmap/ });
    expect(heatmapToggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(heatmapToggle);
    expect(heatmapToggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders owner avatar, overdue badge, and opens the drawer in edit mode from the ✎ button', () => {
    const ASSIGNED_OVERDUE: Risk = {
      ...FIXTURE_RISK,
      id: 'risk-003',
      title: 'Overdue mitigation',
      status: 'MITIGATING',
      mitigation_due_date: '2020-01-01',
      owner: 'user-1',
      owner_name: 'Alex Owner',
      owner_initials: 'AO',
    };
    useRisksState.risks = [ASSIGNED_OVERDUE];
    renderWithProviders(<RiskRegisterView />);

    expect(screen.getByText('AO')).toBeInTheDocument();
    expect(screen.getByText('Alex Owner')).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Edit risk: Overdue mitigation/ }));
    expect(screen.getByRole('dialog', { name: 'Overdue mitigation' })).toBeInTheDocument();
  });

  it('renders critical and high count badges and opens the drawer in create mode from + New risk', () => {
    useRisksState.risks = [FIXTURE_RISK, HIGH_RISK];
    renderWithProviders(<RiskRegisterView />);

    // Both count badges render with the singular/plural aria-label branch
    // (rendered twice: once in the desktop toolbar, once in the mobile pill row).
    expect(screen.getAllByLabelText('1 critical risk').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('1 high risk').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '+ New risk' }));
    expect(screen.getByRole('dialog', { name: 'New risk' })).toBeInTheDocument();
  });

  // ── Segment filter + severity sort (#1170) ────────────────────────────────

  const LOW_RESOLVED: Risk = {
    ...FIXTURE_RISK,
    id: 'risk-low',
    short_id_display: 'R-LOW',
    title: 'Low resolved risk',
    status: 'RESOLVED',
    probability: 2,
    impact: 2,
    severity: 4,
    owner: 'user-2',
  };
  const MINE_HIGH: Risk = {
    ...HIGH_RISK,
    id: 'risk-mine',
    short_id_display: 'R-MINE',
    title: 'My high risk',
    status: 'MITIGATING',
    owner: 'user-1',
  };

  it('renders the segment filter as a radiogroup with four options', () => {
    renderWithProviders(<RiskRegisterView />);
    const group = screen.getByRole('radiogroup', { name: 'Filter risks' });
    expect(within(group).getAllByRole('radio')).toHaveLength(4);
    expect(within(group).getByRole('radio', { name: 'All' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('High filters to severity >= 12', () => {
    useRisksState.risks = [FIXTURE_RISK, LOW_RESOLVED];
    renderWithProviders(<RiskRegisterView />);
    fireEvent.click(screen.getByRole('radio', { name: 'High' }));
    expect(screen.getByText('Critical infrastructure failure')).toBeInTheDocument();
    expect(screen.queryByText('Low resolved risk')).not.toBeInTheDocument();
  });

  it('seeds the High segment from the ?severity=high deep-link (#1691)', () => {
    useRisksState.risks = [FIXTURE_RISK, LOW_RESOLVED];
    renderWithProviders(<RiskRegisterView />, { initialEntries: ['/?severity=high'] });
    expect(screen.getByRole('radio', { name: 'High' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Critical infrastructure failure')).toBeInTheDocument();
    expect(screen.queryByText('Low resolved risk')).not.toBeInTheDocument();
  });

  it('Unmitigated excludes resolved/accepted/closed risks', () => {
    useRisksState.risks = [FIXTURE_RISK, LOW_RESOLVED];
    renderWithProviders(<RiskRegisterView />);
    fireEvent.click(screen.getByRole('radio', { name: 'Unmitigated' }));
    expect(screen.getByText('Critical infrastructure failure')).toBeInTheDocument();
    expect(screen.queryByText('Low resolved risk')).not.toBeInTheDocument();
  });

  it('Mine filters to risks owned by the current user', () => {
    useRisksState.risks = [FIXTURE_RISK, MINE_HIGH];
    renderWithProviders(<RiskRegisterView />);
    fireEvent.click(screen.getByRole('radio', { name: 'Mine' }));
    expect(screen.getByText('My high risk')).toBeInTheDocument();
    // FIXTURE_RISK has owner null → not mine
    expect(screen.queryByText('Critical infrastructure failure')).not.toBeInTheDocument();
  });

  it('shows a filter-specific empty state with a reset when nothing matches', () => {
    useRisksState.risks = [LOW_RESOLVED]; // owned by user-2, resolved
    renderWithProviders(<RiskRegisterView />);
    fireEvent.click(screen.getByRole('radio', { name: 'Mine' }));
    expect(screen.getByText('None of the risks are assigned to you.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all risks' }));
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Low resolved risk')).toBeInTheDocument();
  });

  it('does not render the placeholder Trend column (#2176)', () => {
    useRisksState.risks = [FIXTURE_RISK];
    renderWithProviders(<RiskRegisterView />);
    expect(screen.queryByRole('columnheader', { name: /Trend/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('No trend data available')).not.toBeInTheDocument();
  });

  it('toggles severity sort and reflects it via aria-sort', () => {
    useRisksState.risks = [FIXTURE_RISK, HIGH_RISK]; // sev 25, sev 16
    renderWithProviders(<RiskRegisterView />);
    const header = screen.getByRole('columnheader', { name: /Severity/ });
    expect(header).toHaveAttribute('aria-sort', 'none');

    const sortButton = within(header).getByRole('button', { name: /Severity/ });
    fireEvent.click(sortButton); // → descending
    expect(header).toHaveAttribute('aria-sort', 'descending');

    // Ascending after a second click reorders the lowest-severity row first.
    fireEvent.click(sortButton); // → ascending
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    const rows = screen.getAllByRole('button', { name: /Open risk:/ });
    expect(rows[0]).toHaveAccessibleName(/Vendor delay/); // severity 16 < 25
  });

  it('clears both facets via Clear all', () => {
    useRisksState.risks = [FIXTURE_RISK, MINE_HIGH];
    renderWithProviders(<RiskRegisterView />);
    fireEvent.click(screen.getByRole('radio', { name: 'Mine' }));
    expect(screen.getByText(/Filtered to/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.queryByText(/Filtered to/)).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
  });

  // ── Severity-band visibility toggle (#1239) ───────────────────────────────

  it('hides low-severity rows when the "Hide low severity" toggle is checked', () => {
    // FIXTURE_RISK is severity 25 (critical); LOW_RESOLVED is severity 4 (low).
    useRisksState.risks = [FIXTURE_RISK, LOW_RESOLVED];
    renderWithProviders(<RiskRegisterView />);

    // Both rows visible by default.
    expect(screen.getByText('Critical infrastructure failure')).toBeInTheDocument();
    expect(screen.getByText('Low resolved risk')).toBeInTheDocument();

    const toggle = screen.getByRole('checkbox', { name: 'Hide low severity' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);

    // The low-severity row is now hidden; the critical row remains.
    expect(toggle).toBeChecked();
    expect(screen.getByText('Critical infrastructure failure')).toBeInTheDocument();
    expect(screen.queryByText('Low resolved risk')).not.toBeInTheDocument();
  });

  it('persists the hidden-severity choice to localStorage', () => {
    useRisksState.risks = [FIXTURE_RISK, LOW_RESOLVED];
    renderWithProviders(<RiskRegisterView />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide low severity' }));
    expect(localStorage.getItem('trueppm.riskFilters.hiddenSeverities')).toBe(
      JSON.stringify(['low']),
    );
  });

  it('re-applies the persisted hidden-severity preference on remount', () => {
    // Seed the persisted preference before the view mounts.
    localStorage.setItem('trueppm.riskFilters.hiddenSeverities', JSON.stringify(['low']));
    useRisksState.risks = [FIXTURE_RISK, LOW_RESOLVED];
    renderWithProviders(<RiskRegisterView />);

    // The toggle reflects the stored state and the low-severity row is hidden.
    expect(screen.getByRole('checkbox', { name: 'Hide low severity' })).toBeChecked();
    expect(screen.getByText('Critical infrastructure failure')).toBeInTheDocument();
    expect(screen.queryByText('Low resolved risk')).not.toBeInTheDocument();
  });

  it('renders the register summary sub-line "N in register · X high · Y unmitigated" (issue 1230)', () => {
    useRisksState.risks = [FIXTURE_RISK, HIGH_RISK]; // both OPEN, both sev >= 12
    renderWithProviders(<RiskRegisterView />);
    const summary = screen.getByText(
      (_content, el) =>
        el?.tagName.toLowerCase() === 'p' && (el.textContent ?? '').includes('in register'),
    );
    expect(summary.textContent).toContain('2 in register');
    expect(summary.textContent).toContain('2 high');
    expect(summary.textContent).toContain('2 unmitigated');
  });

  it('sorts the table by newest when the Newest toggle is pressed (issue 1230)', () => {
    const older = {
      ...FIXTURE_RISK,
      id: 'o',
      title: 'Older risk',
      created_at: '2026-01-01T00:00:00Z',
    };
    const newer = {
      ...FIXTURE_RISK,
      id: 'n',
      title: 'Newer risk',
      created_at: '2026-03-01T00:00:00Z',
    };
    useRisksState.risks = [older, newer]; // server/input order: Older, Newer
    renderWithProviders(<RiskRegisterView />);

    const newestToggle = screen.getByRole('button', { name: 'Newest' });
    expect(newestToggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(newestToggle);
    expect(newestToggle).toHaveAttribute('aria-pressed', 'true');

    const rows = screen
      .getAllByRole('button', { name: /Open risk:/ })
      .map((r) => r.getAttribute('aria-label') ?? '');
    expect(rows[0]).toContain('Newer risk');
    expect(rows[1]).toContain('Older risk');
  });

  it('Newest and the Severity column sort are mutually exclusive (issue 1230)', () => {
    useRisksState.risks = [FIXTURE_RISK, HIGH_RISK];
    renderWithProviders(<RiskRegisterView />);

    fireEvent.click(screen.getByRole('button', { name: 'Newest' }));
    expect(screen.getByRole('button', { name: 'Newest' })).toHaveAttribute('aria-pressed', 'true');

    // Clicking the Severity header clears the Newest toggle.
    fireEvent.click(screen.getByRole('button', { name: /Severity/ }));
    expect(screen.getByRole('button', { name: 'Newest' })).toHaveAttribute('aria-pressed', 'false');
  });

  // ── Import CSV write gate (issue 223, Member+) ────────────────────────────

  it('hides the Import CSV affordance for a Viewer (role loading / read-only)', () => {
    roleState.value = null; // Viewer / role not yet resolved
    renderWithProviders(<RiskRegisterView />);
    expect(screen.queryByRole('button', { name: 'Import CSV' })).toBeNull();
    // The mobile overflow still exists (Export is available) but has no Import item.
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Import CSV' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Export CSV' })).toBeInTheDocument();
  });

  it('shows the desktop Import CSV button for Member+ and opens the import modal', () => {
    roleState.value = 400; // Owner (>= Member)
    renderWithProviders(<RiskRegisterView />);
    const importBtn = screen.getByRole('button', { name: 'Import CSV' });
    fireEvent.click(importBtn);
    expect(screen.getByRole('dialog', { name: 'Import risks from CSV' })).toBeInTheDocument();
    // The modal owns its own close trigger; closing removes it.
    fireEvent.click(screen.getByRole('button', { name: 'Close import' }));
    expect(screen.queryByRole('dialog', { name: 'Import risks from CSV' })).toBeNull();
  });

  it('offers Import CSV in the empty state for Member+ and opens the modal', () => {
    roleState.value = 100; // Member
    useRisksState.risks = [];
    renderWithProviders(<RiskRegisterView />);
    expect(screen.getByText('No risks yet')).toBeInTheDocument();
    // The empty-state secondary CTA appears alongside the persistent toolbar
    // button; the empty-state one follows the header in the DOM, so click the
    // last match to exercise its own Import branch.
    const importButtons = screen.getAllByRole('button', { name: 'Import CSV' });
    fireEvent.click(importButtons[importButtons.length - 1]);
    expect(screen.getByRole('dialog', { name: 'Import risks from CSV' })).toBeInTheDocument();
  });

  it('opens the import modal from the mobile overflow menuitem for Member+', () => {
    roleState.value = 300; // Admin
    renderWithProviders(<RiskRegisterView />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import CSV' }));
    expect(screen.getByRole('dialog', { name: 'Import risks from CSV' })).toBeInTheDocument();
  });

  // ── Export CSV ────────────────────────────────────────────────────────────

  it('exports the displayed rows with a name-derived slug from the desktop button', () => {
    useRisksState.risks = [FIXTURE_RISK];
    renderWithProviders(<RiskRegisterView />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(exportRisksToCSVMock).toHaveBeenCalledTimes(1);
    // Args: (displayRisks, projectSlug). "Test Project" → "test-project".
    const [rows, slug] = exportRisksToCSVMock.mock.calls[0];
    expect(rows.length).toBe(1);
    expect(slug).toBe('test-project');
  });

  it('exports from the mobile overflow menuitem and then closes the menu', () => {
    renderWithProviders(<RiskRegisterView />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export CSV' }));
    expect(exportRisksToCSVMock).toHaveBeenCalledTimes(1);
    // Selecting a menu action collapses the overflow menu.
    expect(screen.getByRole('button', { name: 'More actions' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  // ── Heatmap loading branch ────────────────────────────────────────────────

  it('renders the heatmap skeleton (not the matrix) while risks load', () => {
    useRisksState.risks = [];
    useRisksState.isLoading = true;
    renderWithProviders(<RiskRegisterView />);
    // The heatmap aside is present (showHeatmap defaults true) but the matrix
    // is replaced by the animated skeleton until the query resolves.
    expect(screen.getByRole('complementary', { name: 'Risk heatmap' })).toBeInTheDocument();
    expect(screen.queryByTestId('risk-matrix')).toBeNull();
  });
});
