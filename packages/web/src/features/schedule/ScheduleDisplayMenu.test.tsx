import { type ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ScheduleDisplayMenu, type DisplayMenuRow } from './ScheduleDisplayMenu';

function setup(overrides: Partial<ComponentProps<typeof ScheduleDisplayMenu>> = {}) {
  const props: ComponentProps<typeof ScheduleDisplayMenu> = {
    showCpOnly: false,
    setShowCpOnly: vi.fn(),
    focusModeEnabled: false,
    setFocusModeEnabled: vi.fn(),
    showCriticalOnly: false,
    setShowCriticalOnly: vi.fn(),
    showMilestonesOnly: false,
    setShowMilestonesOnly: vi.fn(),
    columns: null,
    iconOnly: false,
    ...overrides,
  };
  render(<ScheduleDisplayMenu {...props} />);
  return props;
}

describe('ScheduleDisplayMenu (#1741)', () => {
  it('renders a labeled trigger and no badge when no filters are active', () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'Display' });
    expect(trigger).toBeInTheDocument();
    expect(screen.getByText('Display')).toBeInTheDocument();
    // No active-filter count in the accessible name.
    expect(trigger.getAttribute('aria-label')).toBe('Display');
  });

  it('carries the active-filter count in the trigger accessible name and a badge', () => {
    setup({ showCpOnly: true, showMilestonesOnly: true });
    const trigger = screen.getByRole('button', { name: /display, 2 active filters/i });
    expect(trigger).toBeInTheDocument();
    // The visible pill shows the count (decorative — aria-hidden).
    expect(within(trigger).getByText('2')).toBeInTheDocument();
  });

  it('uses the singular "filter" for exactly one active filter', () => {
    setup({ focusModeEnabled: true });
    expect(screen.getByRole('button', { name: 'Display, 1 active filter' })).toBeInTheDocument();
  });

  it('opens the popover and toggles a filter in place (menu stays open)', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    const menu = screen.getByRole('menu', { name: 'Display options' });
    expect(within(menu).getByText('View filters')).toBeInTheDocument();
    expect(within(menu).getByText('Render filters')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'CP only' }));
    expect(props.setShowCpOnly).toHaveBeenCalledWith(true);
    // Multi-toggle: the menu stays open after a checkbox click.
    expect(screen.getByRole('menu', { name: 'Display options' })).toBeInTheDocument();
  });

  it('omits the Columns section when no columns are provided', () => {
    setup({ columns: null });
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    expect(screen.queryByText('Columns')).toBeNull();
  });

  it('renders the Columns section when columns are provided', () => {
    const onChange = vi.fn();
    const columns: DisplayMenuRow[] = [
      { id: 'dur', label: 'Duration', checked: true, onChange },
      { id: 'start', label: 'Start', checked: false, onChange },
    ];
    setup({ columns });
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    expect(screen.getByText('Columns')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Duration' }));
    // Duration was checked → toggling requests the opposite.
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('closes on Escape and restores focus to the trigger', () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'Display' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Display options' });
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Display options' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('icon-only mode hides the visible label but keeps the accessible name', () => {
    setup({ iconOnly: true, showCpOnly: true });
    // The visible "Display" text is gone…
    expect(screen.queryByText('Display')).toBeNull();
    // …but the trigger still exposes its accessible name (with the active count).
    expect(screen.getByRole('button', { name: 'Display, 1 active filter' })).toBeInTheDocument();
  });

  describe('Chart section (#2097, per-view placement #2107)', () => {
    function chartProps(viewMode: 'grid' | 'timeline' = 'timeline') {
      return {
        dependencyLinesVisible: true,
        setDependencyLinesVisible: vi.fn(),
        viewMode,
        taskNamePlacement: 'next' as const,
        setTaskNamePlacement: vi.fn(),
        progressPillsVisible: true,
        setProgressPillsVisible: vi.fn(),
      };
    }

    it('omits the Chart section when no chart config is provided', () => {
      setup({ chart: null });
      fireEvent.click(screen.getByRole('button', { name: 'Display' }));
      expect(screen.queryByText('Chart')).toBeNull();
    });

    it('renders dependency-lines + progress checkboxes and a task-name radio group', () => {
      const chart = chartProps('timeline');
      setup({ chart });
      fireEvent.click(screen.getByRole('button', { name: 'Display' }));
      expect(screen.getByText('Chart')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Dependency lines' }));
      expect(chart.setDependencyLinesVisible).toHaveBeenCalledWith(false);

      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Progress %' }));
      expect(chart.setProgressPillsVisible).toHaveBeenCalledWith(false);

      // Radio group — three placements in Timeline, "Next to bar" selected.
      const nextToBar = screen.getByRole('menuitemradio', { name: 'Next to bar' });
      expect(nextToBar).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Aligned left' }));
      expect(chart.setTaskNamePlacement).toHaveBeenCalledWith('left');
    });

    it('scopes the task-name sub-label to the active view (Timeline)', () => {
      setup({ chart: chartProps('timeline') });
      fireEvent.click(screen.getByRole('button', { name: 'Display' }));
      expect(screen.getByText('Task names (Timeline)')).toBeInTheDocument();
    });

    it('scopes the sub-label and omits the Timeline-only "Aligned left" option in Grid', () => {
      setup({ chart: chartProps('grid') });
      fireEvent.click(screen.getByRole('button', { name: 'Display' }));
      expect(screen.getByText('Task names (Grid)')).toBeInTheDocument();
      // Grid offers only Next-to-bar and Hidden — the aligned-left gutter is
      // Timeline-only, so its option is not rendered here.
      expect(screen.getByRole('menuitemradio', { name: 'Next to bar' })).toBeInTheDocument();
      expect(screen.getByRole('menuitemradio', { name: 'Hidden' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitemradio', { name: 'Aligned left' })).toBeNull();
    });

    it('adds hidden chart elements to the trigger badge count', () => {
      setup({ chart: chartProps(), hiddenChartCount: 2, showCpOnly: true });
      // 1 active data filter (CP only) + 2 hidden chart elements = 3.
      expect(
        screen.getByRole('button', { name: /display, 3 active filters/i }),
      ).toBeInTheDocument();
    });

    it('shows WBS and Owner among the column toggles', () => {
      const onChange = vi.fn();
      setup({
        columns: [
          { id: 'wbs', label: 'WBS', checked: true, onChange },
          { id: 'owner', label: 'Owner', checked: false, onChange },
        ],
      });
      fireEvent.click(screen.getByRole('button', { name: 'Display' }));
      expect(screen.getByRole('menuitemcheckbox', { name: 'WBS' })).toBeInTheDocument();
      expect(screen.getByRole('menuitemcheckbox', { name: 'Owner' })).toBeInTheDocument();
    });
  });
});
