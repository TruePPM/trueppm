/**
 * CalmToolbar — surface tests for chip popovers, pill toggles, More⋯ overflow,
 * and the layout segmented control. Acceptance criteria from issue #382.
 *
 * The richer integration scenarios (workshop, density persistence) live in
 * BoardView.test.tsx; this file exercises the toolbar in isolation with mocked
 * setters so the assertions remain narrow.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CalmToolbar, type CalmToolbarProps } from './CalmToolbar';

vi.mock('@/hooks/useBoardSavedViews', () => ({
  useBoardSavedViews: () => ({
    views: [],
    isLoading: false,
    create: { mutate: vi.fn(), isPending: false },
    update: { mutate: vi.fn(), isPending: false },
    remove: { mutate: vi.fn(), isPending: false },
  }),
}));

function Harness(overrides: Partial<CalmToolbarProps> = {}) {
  const ref = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const props: CalmToolbarProps = {
    projectId: 'project-1',
    projectName: 'Test Project',
    activeCount: 12,
    backlogCount: 4,
    searchQuery: '',
    onSearchQueryChange: vi.fn(),
    searchMatchCount: 0,
    isSearching: false,
    searchInputRef: searchRef,
    currentViewConfig: {
      sort: 'priority',
      showWip: true,
      showColTints: true,
      evmMode: 'off',
      showCost: false,
      riskLinkedOnly: false,
    },
    activeViewId: null,
    onApplyView: vi.fn(),
    sprints: [],
    selectedSprintId: null,
    onSelectSprint: vi.fn(),
    groupBy: 'phase',
    onGroupByChange: vi.fn(),
    sort: 'priority',
    onSortChange: vi.fn(),
    density: 'comfortable',
    onDensityChange: vi.fn(),
    zoom: 'normal',
    onZoomChange: vi.fn(),
    backlogDensity: 'comfortable',
    onBacklogDensityChange: vi.fn(),
    layout: 'rail',
    onLayoutChange: vi.fn(),
    myTasksEnabled: false,
    myTasksLoading: false,
    onMyTasksToggle: vi.fn(),
    riskLinkedOnly: false,
    onRiskLinkedToggle: vi.fn(),
    debtOnly: false,
    onDebtOnlyToggle: vi.fn(),
    showCost: false,
    onShowCostToggle: vi.fn(),
    activityOpen: false,
    onToggleActivity: vi.fn(),
    onCollapseAll: vi.fn(),
    onExpandAll: vi.fn(),
    showWip: true,
    onShowWipToggle: vi.fn(),
    showColTints: true,
    onShowColTintsToggle: vi.fn(),
    capCellsOn: false,
    onCapCellsToggle: vi.fn(),
    evmMode: 'off',
    onEvmChange: vi.fn(),
    onOpenColumns: vi.fn(),
    onOpenCheatsheet: vi.fn(),
    onExportPdf: vi.fn(),
    exportingPdf: false,
    workshopMode: false,
    onWorkshopToggle: vi.fn(),
    workshopDisabled: false,
    workshopButtonRef: ref,
    ...overrides,
  };
  return <CalmToolbar {...props} />;
}

function renderToolbar(overrides: Partial<CalmToolbarProps> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Harness {...overrides} />
    </QueryClientProvider>,
  );
}

describe('CalmToolbar', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the identity block with project name and activity stats', () => {
    renderToolbar({ projectName: 'Atlas', activeCount: 14, backlogCount: 6 });
    expect(screen.getByText('Atlas')).toBeInTheDocument();
    expect(screen.getByText('14 active · 6 in backlog')).toBeInTheDocument();
  });

  // Acceptance: chip popovers ----------------------------------------------

  // Group swimlanes by phase, assignee (#324), or epic (#364) ---------------

  it('Group chip shows the active mode label and opens a radiogroup', async () => {
    const user = userEvent.setup();
    renderToolbar({ groupBy: 'assignee' });
    const groupChip = screen.getByRole('button', { name: 'Group lanes by' });
    expect(groupChip).toHaveTextContent('By assignee');
    await user.click(groupChip);
    expect(screen.getByRole('radiogroup', { name: 'Group lanes by' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Phase' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: 'By assignee' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('Group chip selection invokes onGroupByChange and closes the popover', async () => {
    const user = userEvent.setup();
    const onGroupByChange = vi.fn();
    renderToolbar({ groupBy: 'phase', onGroupByChange });
    await user.click(screen.getByRole('button', { name: 'Group lanes by' }));
    await user.click(screen.getByRole('radio', { name: 'By assignee' }));
    expect(onGroupByChange).toHaveBeenCalledWith('assignee');
    expect(screen.getByRole('button', { name: 'Group lanes by' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('Group chip offers an Epic option that invokes onGroupByChange("epic") (#364)', async () => {
    const user = userEvent.setup();
    const onGroupByChange = vi.fn();
    renderToolbar({ groupBy: 'epic', onGroupByChange });
    const groupChip = screen.getByRole('button', { name: 'Group lanes by' });
    expect(groupChip).toHaveTextContent('By epic');
    await user.click(groupChip);
    expect(screen.getByRole('radio', { name: 'By epic' })).toHaveAttribute('aria-checked', 'true');
    // Switch away and back to verify the option is wired.
    await user.click(screen.getByRole('radio', { name: 'Phase' }));
    expect(onGroupByChange).toHaveBeenCalledWith('phase');
  });

  it('Sort chip is closed by default and opens a radiogroup popover on click', async () => {
    const user = userEvent.setup();
    renderToolbar();
    const sortChip = screen.getByRole('button', { name: 'Sort tasks by' });
    expect(sortChip).toHaveAttribute('aria-expanded', 'false');
    await user.click(sortChip);
    expect(sortChip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('radiogroup', { name: 'Sort tasks by' })).toBeInTheDocument();
  });

  it('Sort chip selection invokes onSortChange and closes the popover', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    renderToolbar({ onSortChange });
    await user.click(screen.getByRole('button', { name: 'Sort tasks by' }));
    await user.click(screen.getByRole('radio', { name: 'Start date' }));
    expect(onSortChange).toHaveBeenCalledWith('start_date');
    expect(screen.getByRole('button', { name: 'Sort tasks by' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('Density chip exposes board AND backlog density radios', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await user.click(screen.getByRole('button', { name: 'Card density' }));
    expect(screen.getByRole('radio', { name: 'Board card density: Compact' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Backlog card density: Full' })).toBeInTheDocument();
  });

  it('each density option renders a layout-preview icon so the bar view is discoverable (#1925)', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await user.click(screen.getByRole('button', { name: 'Card density' }));
    const compact = screen.getByRole('radio', { name: 'Board card density: Compact' });
    const comfortable = screen.getByRole('radio', { name: 'Board card density: Comfortable' });
    const detailed = screen.getByRole('radio', { name: 'Board card density: Detailed' });
    // Each option carries a decorative (aria-hidden) SVG layout preview.
    expect(compact.querySelector('svg')).toBeInTheDocument();
    expect(comfortable.querySelector('svg')).toBeInTheDocument();
    expect(detailed.querySelector('svg')).toBeInTheDocument();
    expect(compact.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('selecting a backlog density invokes onBacklogDensityChange', async () => {
    const user = userEvent.setup();
    const onBacklogDensityChange = vi.fn();
    renderToolbar({ onBacklogDensityChange });
    await user.click(screen.getByRole('button', { name: 'Card density' }));
    await user.click(screen.getByRole('radio', { name: 'Backlog card density: Compact' }));
    expect(onBacklogDensityChange).toHaveBeenCalledWith('compact');
  });

  // Acceptance: pill toggles -----------------------------------------------

  it('My tasks toggle reports aria-pressed=false by default and true when enabled', () => {
    const { rerender } = renderToolbar({ myTasksEnabled: false });
    expect(screen.getByRole('button', { name: /My tasks/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={qc}>
        <Harness myTasksEnabled />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: /My tasks/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('clicking the Cost pill toggles via onShowCostToggle', async () => {
    const user = userEvent.setup();
    const onShowCostToggle = vi.fn();
    renderToolbar({ onShowCostToggle });
    await user.click(screen.getByRole('button', { name: 'Show cost' }));
    expect(onShowCostToggle).toHaveBeenCalled();
  });

  // Acceptance: tech-debt lens (ADR-0178, #1076) ---------------------------
  it('clicking the Tech debt pill toggles via onDebtOnlyToggle', async () => {
    const user = userEvent.setup();
    const onDebtOnlyToggle = vi.fn();
    renderToolbar({ onDebtOnlyToggle });
    await user.click(screen.getByRole('button', { name: 'Tech-debt only' }));
    expect(onDebtOnlyToggle).toHaveBeenCalled();
  });

  it('Tech debt toggle reflects pressed state', () => {
    renderToolbar({ debtOnly: true });
    expect(screen.getByRole('button', { name: 'Tech-debt only' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  // Acceptance: layout switcher --------------------------------------------

  it('layout segmented control reports the active variant via aria-pressed', () => {
    renderToolbar({ layout: 'rail' });
    expect(screen.getByRole('button', { name: 'Rail' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Drawer' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Queue' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking a layout option calls onLayoutChange with the chosen variant', async () => {
    const user = userEvent.setup();
    const onLayoutChange = vi.fn();
    renderToolbar({ onLayoutChange });
    await user.click(screen.getByRole('button', { name: 'Drawer' }));
    expect(onLayoutChange).toHaveBeenCalledWith('drawer');
  });

  // Acceptance: More⋯ overflow ---------------------------------------------

  it('More⋯ popover exposes Collapse all / Expand all / Show WIP / Column tints / EVM / Keyboard / Workshop', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await user.click(screen.getByRole('button', { name: 'More board controls' }));
    expect(screen.getByRole('button', { name: 'Collapse all lanes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand all lanes' })).toBeInTheDocument();
    expect(screen.getByLabelText('Show WIP limits')).toBeInTheDocument();
    expect(screen.getByLabelText('Show column tints')).toBeInTheDocument();
    expect(screen.getByLabelText('EVM indicators')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '? Keyboard shortcuts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export the board as a PDF' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start workshop session' })).toBeInTheDocument();
  });

  // Acceptance: Columns/WIP affordance (#1960) ------------------------------

  it('surfaces a primary "Board columns & WIP limits" button on the toolbar (not in the ⋯ menu)', () => {
    renderToolbar();
    // Visible without opening the ⋯ More overflow — the whole point of #1960.
    expect(
      screen.getByRole('button', { name: 'Board columns & WIP limits' }),
    ).toBeInTheDocument();
  });

  it('Columns button invokes onOpenColumns', async () => {
    const user = userEvent.setup();
    const onOpenColumns = vi.fn();
    renderToolbar({ onOpenColumns });
    await user.click(screen.getByRole('button', { name: 'Board columns & WIP limits' }));
    expect(onOpenColumns).toHaveBeenCalledTimes(1);
  });

  it('no longer lists "⚙ Columns…" inside the ⋯ More overflow', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await user.click(screen.getByRole('button', { name: 'More board controls' }));
    expect(
      screen.queryByRole('button', { name: 'Open board column settings' }),
    ).not.toBeInTheDocument();
  });

  it('Export PDF item invokes onExportPdf', async () => {
    const user = userEvent.setup();
    const onExportPdf = vi.fn();
    renderToolbar({ onExportPdf });
    await user.click(screen.getByRole('button', { name: 'More board controls' }));
    await user.click(screen.getByRole('button', { name: 'Export the board as a PDF' }));
    expect(onExportPdf).toHaveBeenCalledTimes(1);
  });

  it('Export PDF item is disabled and aria-busy while a generation is in flight', async () => {
    const user = userEvent.setup();
    renderToolbar({ exportingPdf: true });
    await user.click(screen.getByRole('button', { name: 'More board controls' }));
    const item = screen.getByRole('button', { name: 'Export the board as a PDF' });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute('aria-busy', 'true');
  });

  it('More⋯ checkbox toggles reflect the current pref state', async () => {
    const user = userEvent.setup();
    renderToolbar({ showWip: false, showColTints: true });
    await user.click(screen.getByRole('button', { name: 'More board controls' }));
    expect(screen.getByLabelText<HTMLInputElement>('Show WIP limits').checked).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>('Show column tints').checked).toBe(true);
  });

  it('clicking outside the chip closes the popover', async () => {
    const user = userEvent.setup();
    const { container } = renderToolbar();
    const chip = screen.getByRole('button', { name: 'Sort tasks by' });
    await user.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    // Click an element guaranteed to be outside the popover and chip.
    await user.click(container);
    expect(chip).toHaveAttribute('aria-expanded', 'false');
  });

  // Acceptance: roving tabindex (web rule 167) --------------------------------

  it('Group chip: only the selected radio has tabIndex=0 (roving tabindex)', async () => {
    const user = userEvent.setup();
    renderToolbar({ groupBy: 'assignee' });
    await user.click(screen.getByRole('button', { name: 'Group lanes by' }));
    expect(screen.getByRole('radio', { name: 'By assignee' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Phase' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('radio', { name: 'By epic' })).toHaveAttribute('tabindex', '-1');
  });

  it('Group chip: ArrowDown moves focus to the next option without committing', async () => {
    const user = userEvent.setup();
    const onGroupByChange = vi.fn();
    renderToolbar({ groupBy: 'phase', onGroupByChange });
    await user.click(screen.getByRole('button', { name: 'Group lanes by' }));
    const phaseRadio = screen.getByRole('radio', { name: 'Phase' });
    fireEvent.keyDown(phaseRadio, { key: 'ArrowDown' });
    // Focus moves to "By assignee" but selection hasn't been committed yet.
    expect(screen.getByRole('radio', { name: 'By assignee' })).toHaveAttribute('tabindex', '0');
    expect(onGroupByChange).not.toHaveBeenCalled();
  });

  it('Group chip: ArrowUp from the first option wraps to the last', async () => {
    const user = userEvent.setup();
    renderToolbar({ groupBy: 'phase' });
    await user.click(screen.getByRole('button', { name: 'Group lanes by' }));
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Phase' }), { key: 'ArrowUp' });
    expect(screen.getByRole('radio', { name: 'By epic' })).toHaveAttribute('tabindex', '0');
  });

  it('Group chip: End moves focus to the last option', async () => {
    const user = userEvent.setup();
    renderToolbar({ groupBy: 'phase' });
    await user.click(screen.getByRole('button', { name: 'Group lanes by' }));
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Phase' }), { key: 'End' });
    expect(screen.getByRole('radio', { name: 'By epic' })).toHaveAttribute('tabindex', '0');
  });

  it('Sort chip: only the selected radio has tabIndex=0', async () => {
    const user = userEvent.setup();
    renderToolbar({ sort: 'start_date' });
    await user.click(screen.getByRole('button', { name: 'Sort tasks by' }));
    expect(screen.getByRole('radio', { name: 'Start date' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Priority' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('radio', { name: '% complete' })).toHaveAttribute('tabindex', '-1');
  });

  it('Sort chip: ArrowDown moves focus to the next option without committing', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    renderToolbar({ sort: 'priority', onSortChange });
    await user.click(screen.getByRole('button', { name: 'Sort tasks by' }));
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Priority' }), { key: 'ArrowDown' });
    expect(screen.getByRole('radio', { name: 'Start date' })).toHaveAttribute('tabindex', '0');
    expect(onSortChange).not.toHaveBeenCalled();
  });

  it('Sort chip: ArrowDown from the last option wraps to the first', async () => {
    const user = userEvent.setup();
    renderToolbar({ sort: 'percent_complete' });
    await user.click(screen.getByRole('button', { name: 'Sort tasks by' }));
    fireEvent.keyDown(screen.getByRole('radio', { name: '% complete' }), { key: 'ArrowDown' });
    expect(screen.getByRole('radio', { name: 'Priority' })).toHaveAttribute('tabindex', '0');
  });

  it('Sort chip: Home moves focus to the first option', async () => {
    const user = userEvent.setup();
    renderToolbar({ sort: 'percent_complete' });
    await user.click(screen.getByRole('button', { name: 'Sort tasks by' }));
    fireEvent.keyDown(screen.getByRole('radio', { name: '% complete' }), { key: 'Home' });
    expect(screen.getByRole('radio', { name: 'Priority' })).toHaveAttribute('tabindex', '0');
  });

  it('Density chip: board card and backlog card groups each have independent roving tabindex', async () => {
    const user = userEvent.setup();
    renderToolbar({ density: 'compact', backlogDensity: 'full' });
    await user.click(screen.getByRole('button', { name: 'Card density' }));
    // Board card group: "Compact" is selected → tabIndex=0
    expect(screen.getByRole('radio', { name: 'Board card density: Compact' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(screen.getByRole('radio', { name: 'Board card density: Comfortable' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
    // Backlog group: "Full" is selected → tabIndex=0
    expect(screen.getByRole('radio', { name: 'Backlog card density: Full' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(screen.getByRole('radio', { name: 'Backlog card density: Compact' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });
});
