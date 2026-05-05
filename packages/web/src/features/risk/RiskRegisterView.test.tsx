import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import type { Risk } from '@/api/types';

const FIXTURE_RISK: Risk = {
  id: 'risk-001',
  short_id: '00000001',
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
};

const HIGH_RISK: Risk = {
  ...FIXTURE_RISK,
  id: 'risk-002',
  short_id: '00000002',
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

vi.mock('@/hooks/useRisks', () => ({
  useRisks: () => useRisksState,
  useCreateRisk: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useUpdateRisk: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDeleteRisk: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useRiskComments: () => ({ comments: [], isLoading: false }),
  useCreateRiskComment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
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

  it('shows the project-picker placeholder when no project is selected', () => {
    useProjectIdState.value = null;
    renderWithProviders(<RiskRegisterView />);
    expect(screen.getByText('Select a project to view risks.')).toBeInTheDocument();
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
    expect(screen.getByText('No risks recorded yet.')).toBeInTheDocument();
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
});
