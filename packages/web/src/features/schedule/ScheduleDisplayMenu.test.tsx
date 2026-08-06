import { type ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ScheduleDisplayMenu, type DisplayMenuRow } from './ScheduleDisplayMenu';

type MenuProps = ComponentProps<typeof ScheduleDisplayMenu>;

function baseProps(overrides: Partial<MenuProps> = {}): MenuProps {
  return {
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
}

function setup(overrides: Partial<MenuProps> = {}) {
  const props = baseProps(overrides);
  render(<ScheduleDisplayMenu {...props} />);
  return props;
}

/** Like {@link setup} but hands back the render result so a test can rerender. */
function setupRerenderable(overrides: Partial<MenuProps> = {}) {
  const props = baseProps(overrides);
  const view = render(<ScheduleDisplayMenu {...props} />);
  return {
    props,
    rerender: (next: Partial<MenuProps>) =>
      view.rerender(<ScheduleDisplayMenu {...baseProps({ ...overrides, ...next })} />),
  };
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /^Display/ }));
  return screen.getByRole('menu', { name: 'Display options' });
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
        sprintBandsVisible: true,
        setSprintBandsVisible: vi.fn() as ((v: boolean) => void) | undefined,
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

    it('renders Sprint windows in Chart, not among the view filters (#2738)', () => {
      const chart = chartProps('timeline');
      setup({ chart });
      fireEvent.click(screen.getByRole('button', { name: 'Display' }));

      const row = screen.getByRole('menuitemcheckbox', { name: 'Sprint windows' });
      expect(row).toHaveAttribute('aria-checked', 'true');
      // A filter changes which work you are looking at; this changes only whether
      // the window behind it is drawn — so it lives beside the other paint
      // toggles, and turning it off is not a switch to some "sprint view".
      const chartGroup = screen.getByRole('group', { name: 'Chart' });
      expect(within(chartGroup).getByRole('menuitemcheckbox', { name: 'Sprint windows' })).toBe(row);

      fireEvent.click(row);
      expect(chart.setSprintBandsVisible).toHaveBeenCalledWith(false);
    });

    it('omits Sprint windows when the host has no sprint context', () => {
      const chart = chartProps('timeline');
      // The read-only program schedule view renders the Chart section without
      // any sprint wiring — the row must simply not exist there.
      chart.setSprintBandsVisible = undefined;
      setup({ chart });
      fireEvent.click(screen.getByRole('button', { name: 'Display' }));
      expect(screen.queryByRole('menuitemcheckbox', { name: 'Sprint windows' })).toBeNull();
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

describe('ScheduleDisplayMenu — trigger keyboard contract', () => {
  it('opens on ArrowDown with the first row focused', () => {
    setup();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Display' }), { key: 'ArrowDown' });
    expect(screen.getByRole('menu', { name: 'Display options' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: 'CP only' })).toHaveFocus();
  });

  it.each(['Enter', ' '])('opens on %s with the first row focused', (key) => {
    setup();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Display' }), { key });
    expect(screen.getByRole('menu', { name: 'Display options' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: 'CP only' })).toHaveFocus();
  });

  it('opens on ArrowUp with the LAST row focused', () => {
    setup();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Display' }), { key: 'ArrowUp' });
    expect(screen.getByRole('menuitemcheckbox', { name: 'Milestones' })).toHaveFocus();
  });

  it('ignores keys that are not part of the open contract', () => {
    setup();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Display' }), { key: 'a' });
    expect(screen.queryByRole('menu', { name: 'Display options' })).toBeNull();
  });
});

describe('ScheduleDisplayMenu — roving keyboard navigation', () => {
  it('ArrowDown moves focus to the next row', () => {
    setup();
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitemcheckbox', { name: 'Focus chain' })).toHaveFocus();
  });

  it('ArrowUp from the first row wraps to the last', () => {
    setup();
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitemcheckbox', { name: 'Milestones' })).toHaveFocus();
  });

  it('ArrowDown from the last row wraps back to the first', () => {
    setup();
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'End' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitemcheckbox', { name: 'CP only' })).toHaveFocus();
  });

  it('End jumps to the last row and Home back to the first', () => {
    setup();
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(screen.getByRole('menuitemcheckbox', { name: 'Milestones' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(screen.getByRole('menuitemcheckbox', { name: 'CP only' })).toHaveFocus();
  });

  it('End reaches a Columns row when the columns section is present', () => {
    setup({
      columns: [{ id: 'wbs', label: 'WBS', checked: false, onChange: vi.fn() }],
    });
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(screen.getByRole('menuitemcheckbox', { name: 'WBS' })).toHaveFocus();
  });

  it('Tab closes the menu and falls through instead of restoring the trigger', () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'Display' });
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'Tab' });
    expect(screen.queryByRole('menu', { name: 'Display options' })).toBeNull();
    expect(trigger).not.toHaveFocus();
  });

  it('leaves the menu open for keys it does not handle', () => {
    setup();
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'x' });
    expect(screen.getByRole('menu', { name: 'Display options' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: 'CP only' })).toHaveFocus();
  });

  it('clamps a stale roving index when the row list shrinks (#2107)', () => {
    // Open with the Columns section present (6 rows) and park focus on the last
    // row, then drop the section: a stale index would focus past the array and
    // drop focus to <body>.
    const { rerender } = setupRerenderable({
      columns: [
        { id: 'wbs', label: 'WBS', checked: false, onChange: vi.fn() },
        { id: 'owner', label: 'Owner', checked: false, onChange: vi.fn() },
      ],
    });
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(screen.getByRole('menuitemcheckbox', { name: 'Owner' })).toHaveFocus();

    rerender({ columns: null });
    expect(screen.queryByText('Columns')).toBeNull();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Milestones' })).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });
});

describe('ScheduleDisplayMenu — dismissal and trigger state', () => {
  it('closes on an outside pointerdown', () => {
    setup();
    openMenu();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu', { name: 'Display options' })).toBeNull();
  });

  it('stays open for a pointerdown inside the menu', () => {
    setup();
    const menu = openMenu();
    fireEvent.pointerDown(menu);
    expect(screen.getByRole('menu', { name: 'Display options' })).toBeInTheDocument();
  });

  it('stays open for a pointerdown on the trigger itself (the click handler owns the toggle)', () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'Display' });
    openMenu();
    fireEvent.pointerDown(trigger);
    expect(screen.getByRole('menu', { name: 'Display options' })).toBeInTheDocument();
  });

  it('toggles closed on a second trigger click', () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'Display' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu', { name: 'Display options' })).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu', { name: 'Display options' })).toBeNull();
  });

  it('reflects the open state in aria-expanded and aria-controls', () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'Display' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveAttribute('aria-controls');
    const menu = openMenu();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', menu.id);
  });

  it('adds a hover tooltip only in icon-only mode', () => {
    setup({ iconOnly: true, showCpOnly: true });
    expect(screen.getByRole('button', { name: /^Display/ })).toHaveAttribute(
      'title',
      'Display, 1 active filter',
    );
  });

  it('omits the tooltip when the label is visible', () => {
    setup({ iconOnly: false });
    expect(screen.getByRole('button', { name: 'Display' })).not.toHaveAttribute('title');
  });
});

describe('ScheduleDisplayMenu — section assembly edge cases', () => {
  it('omits the Columns section for an empty column list', () => {
    setup({ columns: [] });
    openMenu();
    expect(screen.queryByText('Columns')).toBeNull();
    // Only the two always-present filter sections remain.
    expect(screen.getAllByRole('menuitemcheckbox')).toHaveLength(4);
  });

  it('floors a negative hidden-chart count at zero in the badge', () => {
    setup({ showCpOnly: true, hiddenChartCount: -3 });
    expect(screen.getByRole('button', { name: 'Display, 1 active filter' })).toBeInTheDocument();
  });

  it('counts every data filter and hidden chart element together', () => {
    setup({
      showCpOnly: true,
      focusModeEnabled: true,
      showCriticalOnly: true,
      showMilestonesOnly: true,
      hiddenChartCount: 1,
    });
    expect(screen.getByRole('button', { name: 'Display, 5 active filters' })).toBeInTheDocument();
  });

  it('marks unchecked rows aria-checked=false and checked rows true', () => {
    setup({ showCpOnly: true });
    openMenu();
    expect(screen.getByRole('menuitemcheckbox', { name: 'CP only' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('menuitemcheckbox', { name: 'Focus chain' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('separates sections after the first with a separator', () => {
    setup();
    const menu = openMenu();
    // Two sections → exactly one separator between them.
    expect(within(menu).getAllByRole('separator')).toHaveLength(1);
  });

  it('toggles an already-active filter back off', () => {
    const props = setup({ showCriticalOnly: true, showMilestonesOnly: true });
    openMenu();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Critical path' }));
    expect(props.setShowCriticalOnly).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Milestones' }));
    expect(props.setShowMilestonesOnly).toHaveBeenCalledWith(false);
  });

  it('toggles the focus chain on from the menu', () => {
    const props = setup();
    openMenu();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Focus chain' }));
    expect(props.setFocusModeEnabled).toHaveBeenCalledWith(true);
  });

  it('reaches the chart rows with End when the Chart section is present', () => {
    const chart = {
      dependencyLinesVisible: false,
      setDependencyLinesVisible: vi.fn(),
      viewMode: 'grid' as const,
      taskNamePlacement: 'hidden' as const,
      setTaskNamePlacement: vi.fn(),
      progressPillsVisible: false,
      setProgressPillsVisible: vi.fn(),
    };
    setup({ chart });
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'End' });
    // Grid: 4 filters + dependency lines + 2 radios + progress = last row is Progress %.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Progress %' })).toHaveFocus();
    expect(screen.getByRole('menuitemradio', { name: 'Hidden' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Dependency lines' }));
    expect(chart.setDependencyLinesVisible).toHaveBeenCalledWith(true);
  });
});
