import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { useScheduleStore } from '@/stores/scheduleStore';
import { TaskListRow, truncateWbsPath } from './TaskListRow';
import type { Task } from '@/types';
import type { ColumnWidths } from '@/hooks/useColumnWidths';

const defaultWidths: ColumnWidths['widths'] = {
  wbs: 48, task: 180, links: 76, dur: 52, start: 74, finish: 74, progress: 52, owner: 72,
};

const defaultVisible: ColumnWidths['visible'] = {
  wbs: true, task: true, links: true, dur: true, start: true, finish: true, progress: true, owner: true,
};

const base: Task = {
  id: 't1', wbs: '1.1', name: 'Design Phase', start: '2026-10-05', finish: '2026-10-15',
  duration: 10, progress: 50, parentId: 't0',
  isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
  status: 'NOT_STARTED',
  assignees: [],
  notes: '',
};

const defaultTreeProps = {
  hasChildren: false,
  isExpanded: false,
  onToggleId: vi.fn(),
};

describe('truncateWbsPath', () => {
  it('returns paths that fit unchanged', () => {
    expect(truncateWbsPath('1.2.3', 6)).toBe('1.2.3');
    expect(truncateWbsPath('10', 6)).toBe('10');
  });

  it('truncates with mid-string ellipsis preserving leaf segment', () => {
    expect(truncateWbsPath('1.10.5.2', 6)).toBe('1.…2');
    expect(truncateWbsPath('a.b.c.d.e', 6)).toBe('a.…e');
  });

  it('falls back to end-truncate for two-segment paths', () => {
    expect(truncateWbsPath('1234.5678', 5)).toBe('1234…');
  });

  it('handles tiny budgets safely', () => {
    expect(truncateWbsPath('1.2.3', 2)).toBe('…');
    expect(truncateWbsPath('1.2.3', 0)).toBe('…');
  });
});

describe('TaskListRow — WBS column (#248)', () => {
  it('renders the WBS path in the wbs column', () => {
    renderWithRouter(
      <TaskListRow task={base} level={2} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />,
    );
    expect(screen.getByLabelText('WBS 1.1')).toBeInTheDocument();
  });

  it('hides the WBS column when not visible', () => {
    const visible = { ...defaultVisible, wbs: false };
    renderWithRouter(
      <TaskListRow task={base} level={2} widths={defaultWidths} visible={visible} {...defaultTreeProps} />,
    );
    expect(screen.queryByLabelText('WBS 1.1')).toBeNull();
  });
});

describe('TaskListRow — Owner column (#248)', () => {
  it('shows assignees in the Owner column when task has them', () => {
    const taskWithAssignees = {
      ...base,
      assignees: [
        { resourceId: 'r1', name: 'Alice', units: 1 },
        { resourceId: 'r2', name: 'Bob', units: 0.5 },
      ],
    };
    renderWithRouter(
      <TaskListRow task={taskWithAssignees} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />,
    );
    // #3154: the name carries units, not just names — the chips are aria-hidden and
    // the visible run is too, so this is the only channel that states allocation.
    expect(screen.getByLabelText('Owner: Alice (100%), Bob (50%)')).toBeInTheDocument();
  });

  it('states per-assignee allocation in the Owner cell name (#3154)', () => {
    const taskWithAssignees = {
      ...base,
      assignees: [
        { resourceId: 'r1', name: 'Alice', units: 1 },
        { resourceId: 'r2', name: 'Bob', units: 0.5 },
      ],
    };
    renderWithRouter(
      <TaskListRow task={taskWithAssignees} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />,
    );
    const cell = screen.getByLabelText(/^Owner: Alice/);
    expect(cell).toHaveAccessibleName('Owner: Alice (100%), Bob (50%)');
    // …and the same fact is drawn, not just named (rule 328(b)).
    expect(within(cell).getByText('100/50%')).toBeVisible();
    // …exactly once: the drawn copy is hidden from assistive tech.
    expect(within(cell).getByText('100/50%')).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows "Owner: none" when task has no assignees', () => {
    renderWithRouter(
      <TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />,
    );
    expect(screen.getByLabelText('Owner: none')).toBeInTheDocument();
  });

  it('renders empty Owner cell for summary tasks', () => {
    const summary = { ...base, isSummary: true, assignees: [{ resourceId: 'r1', name: 'Alice', units: 1 }] };
    renderWithRouter(
      <TaskListRow task={summary} level={1} widths={defaultWidths} visible={defaultVisible} />,
    );
    expect(screen.getByLabelText('Summary task — owner column empty')).toBeInTheDocument();
  });

  it('renders +N overflow when more than 3 assignees', () => {
    const fiveAssignees = {
      ...base,
      assignees: [
        { resourceId: 'r1', name: 'Alice', units: 1 },
        { resourceId: 'r2', name: 'Bob', units: 1 },
        { resourceId: 'r3', name: 'Carol', units: 1 },
        { resourceId: 'r4', name: 'Dan', units: 1 },
        { resourceId: 'r5', name: 'Eve', units: 1 },
      ],
    };
    renderWithRouter(
      <TaskListRow task={fiveAssignees} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />,
    );
    expect(screen.getByText('+2')).toBeInTheDocument();
  });
});

describe('TaskListRow — grid ARIA structure & roving tabindex (#2204)', () => {
  it('applies aria-rowindex passed by the panel', () => {
    renderWithRouter(
      <TaskListRow task={base} level={2} widths={defaultWidths} visible={defaultVisible} ariaRowIndex={7} {...defaultTreeProps} />,
    );
    expect(screen.getByRole('row')).toHaveAttribute('aria-rowindex', '7');
  });

  it('is the tab stop (tabIndex 0) when active — the default', () => {
    renderWithRouter(
      <TaskListRow task={base} level={2} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />,
    );
    expect(screen.getByRole('row')).toHaveAttribute('tabindex', '0');
  });

  it('drops the row and its per-row buttons out of the tab order when inactive', () => {
    renderWithRouter(
      <TaskListRow task={base} level={2} widths={defaultWidths} visible={defaultVisible} isActiveRow={false} {...defaultTreeProps} />,
    );
    expect(screen.getByRole('row')).toHaveAttribute('tabindex', '-1');
    // The properties button must not add a tab stop for an inactive row.
    expect(screen.getByLabelText(/Open properties/i)).toHaveAttribute('tabindex', '-1');
  });

  it('exposes the Task-name column as a gridcell, like its sibling columns', () => {
    renderWithRouter(
      <TaskListRow task={base} level={2} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />,
    );
    // The task name lives inside a role="gridcell" (not a bare div).
    const nameCell = screen.getByText('Design Phase').closest('[role="gridcell"]');
    expect(nameCell).not.toBeNull();
  });

  it('routes Home/End to the panel edge-jump callback', () => {
    const onFocusEdge = vi.fn();
    renderWithRouter(
      <TaskListRow task={base} level={2} widths={defaultWidths} visible={defaultVisible} onFocusEdge={onFocusEdge} {...defaultTreeProps} />,
    );
    const row = screen.getByRole('row');
    fireEvent.keyDown(row, { key: 'Home' });
    fireEvent.keyDown(row, { key: 'End' });
    expect(onFocusEdge).toHaveBeenNthCalledWith(1, 'first');
    expect(onFocusEdge).toHaveBeenNthCalledWith(2, 'last');
  });

  // #2727: real treegrid semantics, not just role="grid" > role="row".
  it('exposes aria-level from the WBS depth (1-based, matching the level prop directly)', () => {
    renderWithRouter(
      <TaskListRow task={base} level={3} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />,
    );
    expect(screen.getByRole('row')).toHaveAttribute('aria-level', '3');
  });

  it('omits aria-expanded entirely on a leaf row (no children)', () => {
    renderWithRouter(
      <TaskListRow task={base} level={2} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />,
    );
    expect(screen.getByRole('row')).not.toHaveAttribute('aria-expanded');
  });

  it('exposes aria-expanded="true" on an expanded summary row', () => {
    renderWithRouter(
      <TaskListRow
        task={base}
        level={1}
        widths={defaultWidths}
        visible={defaultVisible}
        hasChildren
        isExpanded
        onToggleId={vi.fn()}
      />,
    );
    expect(screen.getByRole('row')).toHaveAttribute('aria-expanded', 'true');
  });

  it('exposes aria-expanded="false" on a collapsed summary row', () => {
    renderWithRouter(
      <TaskListRow
        task={base}
        level={1}
        widths={defaultWidths}
        visible={defaultVisible}
        hasChildren
        isExpanded={false}
        onToggleId={vi.fn()}
      />,
    );
    expect(screen.getByRole('row')).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('TaskListRow', () => {
  beforeEach(() => {
    useScheduleStore.setState({ selectedTaskId: null });
  });

  it('renders task name', () => {
    renderWithRouter(<TaskListRow task={base} level={2} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />);
    expect(screen.getByText('Design Phase')).toBeInTheDocument();
  });

  it('renders duration and progress', () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />);
    expect(screen.getByLabelText('10 days')).toBeInTheDocument();
    expect(screen.getByLabelText(/50% complete/i)).toBeInTheDocument();
  });

  it('rounds a fractional summary-rollup progress to a whole percent (#973)', () => {
    // Summary rows carry a duration-weighted rollup (e.g. 31.36); leaf rows are
    // integers. The cell must display a whole percent, not the raw fraction.
    renderWithRouter(
      <TaskListRow
        task={{ ...base, isSummary: true, progress: 31.36 }}
        level={1}
        widths={defaultWidths}
        visible={defaultVisible}
        {...defaultTreeProps}
      />,
    );
    expect(screen.getByText('31%')).toBeInTheDocument();
    expect(screen.queryByText('31.36%')).not.toBeInTheDocument();
    expect(screen.getByLabelText('31% complete')).toBeInTheDocument();
  });

  it('renders duration without start date when unscheduled', () => {
    renderWithRouter(
      <TaskListRow task={{ ...base, start: '' }} level={1} widths={defaultWidths} visible={defaultVisible} />,
    );
    expect(screen.getByLabelText('10 days')).toBeInTheDocument();
    expect(screen.getByLabelText('unscheduled')).toBeInTheDocument();
  });

  it('critical task has aria-label mentioning critical path', () => {
    renderWithRouter(<TaskListRow task={{ ...base, isCritical: true }} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />);
    expect(screen.getByLabelText(/critical path/i)).toBeInTheDocument();
  });

  // Rule-49 (issue 734): the critical-path signal is not color-only — the task
  // name carries the explanatory HTML `title` tooltip alongside color + aria-label.
  it('critical task name has the explanatory title tooltip', () => {
    renderWithRouter(<TaskListRow task={{ ...base, isCritical: true }} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />);
    const nameEl = screen.getByText('Design Phase');
    expect(nameEl).toHaveAttribute(
      'title',
      'This task is on the critical path — a delay here delays the project end date',
    );
  });

  it('non-critical task name does not use the critical-path tooltip', () => {
    renderWithRouter(<TaskListRow task={{ ...base, isCritical: false }} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />);
    const nameEl = screen.getByText('Design Phase');
    expect(nameEl.getAttribute('title')).not.toMatch(/on the critical path/i);
  });

  // CPM float / critical-path annotation on the milestone rollup cell (issue 551) --
  const milestoneRollup = {
    percent_complete: 50,
    rollup_basis: 'points' as const,
    variance_days: 3,
    sprint_scope_changed: false,
    sprint_count: 1,
  };

  it('milestone rollup cell annotates the variance with float and stays amber within float', () => {
    renderWithRouter(
      <TaskListRow
        task={{ ...base, isMilestone: true, duration: 0, progress: 0, totalFloat: 8, milestoneRollup }}
        level={1}
        widths={defaultWidths}
        visible={defaultVisible}
        {...defaultTreeProps}
      />,
    );
    const chip = screen.getByText(/\+3d · 8d float/);
    expect(chip.className).toMatch(/text-semantic-at-risk/);
  });

  it('milestone rollup cell forces red + "critical path" for a critical milestone', () => {
    renderWithRouter(
      <TaskListRow
        task={{
          ...base,
          isMilestone: true,
          duration: 0,
          progress: 0,
          totalFloat: 0,
          isCritical: true,
          milestoneRollup: { ...milestoneRollup, variance_days: 2 },
        }}
        level={1}
        widths={defaultWidths}
        visible={defaultVisible}
        {...defaultTreeProps}
      />,
    );
    const chip = screen.getByText(/\+2d · critical path/);
    expect(chip.className).toMatch(/text-semantic-critical/);
  });

  it('summary task applies font-medium style', () => {
    renderWithRouter(<TaskListRow task={{ ...base, isSummary: true }} level={1} widths={defaultWidths} visible={defaultVisible} />);
    const nameEl = screen.getByText('Design Phase');
    expect(nameEl.className).toContain('font-medium');
  });

  it('milestone shows diamond and hides duration/progress', () => {
    renderWithRouter(<TaskListRow task={{ ...base, isMilestone: true, duration: 0, progress: 0 }} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />);
    // House SVG, never the ◆ codepoint (rule 242 / issue 1749).
    expect(screen.getByTestId('milestone-glyph')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('◆');
    // #3258: Dur states the ZERO, it does not dash. An em-dash reads as "unknown",
    // and a gate whose duration is unknown is the wrong thing to say about the one
    // row type defined by having none. Both channels agree (web rule 287).
    const durCell = screen.getByLabelText('0 days — milestone');
    expect(durCell).toHaveTextContent('0d');
    expect(screen.queryByLabelText('milestone')).not.toBeInTheDocument();
  });

  it('seeded-and-untouched task shows the tick mark (#2731, ADR-0799 §4)', () => {
    renderWithRouter(
      <TaskListRow
        task={{ ...base, isUntouchedSeed: true }}
        level={1}
        widths={defaultWidths}
        visible={defaultVisible}
        {...defaultTreeProps}
      />,
    );
    expect(screen.getByTestId('seeded-untouched-glyph')).toBeInTheDocument();
  });

  it('a hand-authored (or since-edited) task shows no tick mark', () => {
    renderWithRouter(
      <TaskListRow
        task={{ ...base, isUntouchedSeed: false }}
        level={1}
        widths={defaultWidths}
        visible={defaultVisible}
        {...defaultTreeProps}
      />,
    );
    expect(screen.queryByTestId('seeded-untouched-glyph')).toBeNull();
  });

  it('milestone Finish column renders em-dash and never a date range', () => {
    // Regression for !221: even if the API returns a finish date that differs from start
    // (e.g. legacy data where the milestone invariant was bypassed), the row must not
    // render a span — it would contradict the diamond marker and be a credibility risk
    // when a PM shows the Schedule to a client.
    renderWithRouter(
      <TaskListRow
        task={{
          ...base,
          isMilestone: true,
          duration: 0,
          progress: 0,
          start: '2026-10-05',
          finish: '2026-10-25',
        }}
        level={1}
        widths={defaultWidths}
        visible={defaultVisible}
        {...defaultTreeProps}
      />,
    );
    // Finish column has the milestone aria-label and renders em-dash, not the (wrong) finish date.
    const finishCell = screen.getByLabelText(/milestone — single date/i);
    expect(finishCell).toHaveTextContent('—');
    // The bogus finish date must not leak into the row text — no "25" anywhere.
    expect(finishCell.textContent).not.toMatch(/25/);
  });

  it('clicking row selects it in the store', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />);
    await userEvent.click(screen.getByRole('row'));
    expect(useScheduleStore.getState().selectedTaskId).toBe('t1');
  });

  it('clicking selected row deselects it', async () => {
    useScheduleStore.setState({ selectedTaskId: 't1' });
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />);
    await userEvent.click(screen.getByRole('row'));
    expect(useScheduleStore.getState().selectedTaskId).toBeNull();
  });

  it('Enter key toggles selection', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} />);
    const row = screen.getByRole('row');
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(useScheduleStore.getState().selectedTaskId).toBe('t1');
  });

  it('Space key NO LONGER toggles selection — it fires Mark complete now (#477, ADR-0066 Q5)', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} />);
    const row = screen.getByRole('row');
    row.focus();
    await userEvent.keyboard(' ');
    // The behavior change: Space no longer opens the drawer; it dispatches a
    // status mutation. The drawer-toggling path stays bound to Enter.
    expect(useScheduleStore.getState().selectedTaskId).toBeNull();
  });

  it('F2 key enters edit mode', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} />);
    const row = screen.getByRole('row');
    row.focus();
    await userEvent.keyboard('{F2}');
    expect(screen.getByLabelText(/Rename item/i)).toBeInTheDocument();
  });

  it('double-click enters edit mode', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} />);
    await userEvent.dblClick(screen.getByRole('row'));
    expect(screen.getByLabelText(/Rename item/i)).toBeInTheDocument();
  });

  it('Escape cancels edit', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} />);
    await userEvent.dblClick(screen.getByRole('row'));
    const input = screen.getByLabelText(/Rename item/i);
    await userEvent.type(input, 'New Name');
    await userEvent.keyboard('{Escape}');
    // Should exit edit mode without renaming
    expect(screen.queryByLabelText(/Rename item/i)).not.toBeInTheDocument();
    expect(screen.getByText('Design Phase')).toBeInTheDocument();
  });

  it('Enter in edit mode commits the change', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} />);
    await userEvent.dblClick(screen.getByRole('row'));
    const input = screen.getByLabelText(/Rename item/i);
    await userEvent.clear(input);
    await userEvent.type(input, 'Updated Name');
    await userEvent.keyboard('{Enter}');
    // Should exit edit mode
    expect(screen.queryByLabelText(/Rename item/i)).not.toBeInTheDocument();
  });

  it('blur commits edit', async () => {
    renderWithRouter(
      <div>
        <TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} />
        <button type="button">Other</button>
      </div>,
    );
    await userEvent.dblClick(screen.getByRole('row'));
    const input = screen.getByLabelText(/Rename item/i);
    await userEvent.clear(input);
    await userEvent.type(input, 'Blur Name');
    await userEvent.click(screen.getByText('Other'));
    expect(screen.queryByLabelText(/Rename item/i)).not.toBeInTheDocument();
  });

  it('properties button selects the task', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} />);
    const propBtn = screen.getByLabelText(/Open properties/i);
    await userEvent.click(propBtn);
    expect(useScheduleStore.getState().selectedTaskId).toBe('t1');
  });

  // Build mode's row click only focuses the row for keyboard editing (it does
  // NOT open the drawer), so this button is the sole discoverable path to the
  // task detail drawer. It must not be opacity-0-until-hover — a mouse user
  // scanning the list with no hover has to be able to see it (#2106 pattern).
  it('properties button is faintly visible at rest, not hidden until hover', () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} />);
    const propBtn = screen.getByLabelText(/Open properties/i);
    expect(propBtn.className).not.toMatch(/\bopacity-0\b/);
  });

  it('renders assignee chips for non-summary non-milestone tasks', () => {
    const taskWithAssignees = {
      ...base,
      assignees: [
        { resourceId: 'r1', name: 'Alice', units: 100 },
        { resourceId: 'r2', name: 'Bob', units: 50 },
      ],
    };
    renderWithRouter(<TaskListRow task={taskWithAssignees} level={1} widths={defaultWidths} visible={defaultVisible} />);
    expect(screen.getByLabelText(/assigned to Alice, Bob/i)).toBeInTheDocument();
  });

  it('does not render assignee chips for summary tasks', () => {
    const summaryTask = {
      ...base,
      isSummary: true,
      assignees: [{ resourceId: 'r1', name: 'Alice', units: 100 }],
    };
    renderWithRouter(<TaskListRow task={summaryTask} level={1} widths={defaultWidths} visible={defaultVisible} />);
    // AssigneeChips should not render for summary tasks
    expect(screen.queryByText('A')).not.toBeInTheDocument();
  });

  it('clicking row during edit mode does not toggle selection', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} />);
    await userEvent.dblClick(screen.getByRole('row'));
    // Now in edit mode — click should not toggle selection
    expect(useScheduleStore.getState().selectedTaskId).toBeNull();
  });

  it('ArrowDown moves selection to the next visible row (#360)', async () => {
    // Render two rows so the second can be queried by data-row-id and
    // become the destination of the arrow-key traversal.
    const next: Task = { ...base, id: 't2', wbs: '1.2', name: 'Build Phase' };
    renderWithRouter(
      <>
        <TaskListRow
          task={base}
          level={1}
          widths={defaultWidths}
          visible={defaultVisible}
          nextTaskId={next.id}
        />
        <TaskListRow
          task={next}
          level={1}
          widths={defaultWidths}
          visible={defaultVisible}
          prevTaskId={base.id}
        />
      </>,
    );
    const rows = screen.getAllByRole('row');
    rows[0].focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(useScheduleStore.getState().selectedTaskId).toBe('t2');
  });

  it('ArrowUp moves selection to the previous visible row (#360)', async () => {
    const prev: Task = { ...base, id: 't0', wbs: '1.0', name: 'Discover' };
    renderWithRouter(
      <>
        <TaskListRow
          task={prev}
          level={1}
          widths={defaultWidths}
          visible={defaultVisible}
          nextTaskId={base.id}
        />
        <TaskListRow
          task={base}
          level={1}
          widths={defaultWidths}
          visible={defaultVisible}
          prevTaskId={prev.id}
        />
      </>,
    );
    const rows = screen.getAllByRole('row');
    rows[1].focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(useScheduleStore.getState().selectedTaskId).toBe('t0');
  });

  it('keyboard events are ignored during edit mode', async () => {
    // `delay: null` + waitFor guard the CI keystroke-drop flake (#2084): with the
    // default delay the last typed character can be dropped on a loaded runner.
    const user = userEvent.setup({ delay: null });
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} />);
    await user.dblClick(screen.getByRole('row'));
    const input = screen.getByLabelText(/Rename item/i);
    // Enter in input commits, Space types a space
    await user.type(input, ' extra');
    await waitFor(() => expect(input).toHaveValue('Design Phase extra'));
  });

  it('renders expand chevron for summary tasks with children', () => {
    const toggleFn = vi.fn();
    renderWithRouter(
      <TaskListRow
        task={{ ...base, isSummary: true }}
        level={1}
        widths={defaultWidths} visible={defaultVisible}
        hasChildren={true}
        isExpanded={false}
        onToggleId={toggleFn}
      />,
    );
    expect(screen.getByLabelText(/Expand Design Phase/i)).toBeInTheDocument();
  });

  it('chevron rotates when expanded', () => {
    renderWithRouter(
      <TaskListRow
        task={{ ...base, isSummary: true }}
        level={1}
        widths={defaultWidths} visible={defaultVisible}
        hasChildren={true}
        isExpanded={true}
        onToggleId={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/Collapse Design Phase/i)).toBeInTheDocument();
    const svg = screen.getByLabelText(/Collapse Design Phase/i).querySelector('svg');
    expect(svg?.getAttribute('class')).toContain('rotate-90');
  });

  it('clicking chevron calls onToggle without toggling selection', async () => {
    const toggleFn = vi.fn();
    renderWithRouter(
      <TaskListRow
        task={{ ...base, isSummary: true }}
        level={1}
        widths={defaultWidths} visible={defaultVisible}
        hasChildren={true}
        isExpanded={false}
        onToggleId={toggleFn}
      />,
    );
    await userEvent.click(screen.getByLabelText(/Expand Design Phase/i));
    expect(toggleFn).toHaveBeenCalledTimes(1);
    // The row passes its own task id so the parent handler stays stable (issue 1521).
    expect(toggleFn).toHaveBeenCalledWith(base.id);
    // Should not toggle selection (stopPropagation)
    expect(useScheduleStore.getState().selectedTaskId).toBeNull();
  });

  it('leaf tasks show spacer instead of chevron', () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />);
    expect(screen.queryByLabelText(/Expand/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Collapse/i)).not.toBeInTheDocument();
  });

  describe('missing-dates warning chip (issue #317)', () => {
    it.each(['IN_PROGRESS', 'REVIEW', 'COMPLETE'] as const)(
      'renders chip when status is %s and plannedStart is null (CPM may have set start)',
      (status) => {
        renderWithRouter(
          <TaskListRow
            task={{ ...base, status, plannedStart: null }}
            level={1}
            widths={defaultWidths}
            visible={defaultVisible}
            {...defaultTreeProps}
          />,
        );
        expect(screen.getByTestId('missing-dates-chip')).toBeInTheDocument();
        expect(
          screen.getByLabelText(
            'No committed start date — dates shown are auto-calculated, not committed.',
          ),
        ).toBeInTheDocument();
        expect(screen.getByText('no committed start')).toBeInTheDocument();
      },
    );

    it('does not render chip when plannedStart is present (PM has committed)', () => {
      renderWithRouter(
        <TaskListRow
          task={{ ...base, status: 'IN_PROGRESS', plannedStart: '2026-10-05' }}
          level={1}
          widths={defaultWidths}
          visible={defaultVisible}
          {...defaultTreeProps}
        />,
      );
      expect(screen.queryByTestId('missing-dates-chip')).not.toBeInTheDocument();
    });

    it.each(['BACKLOG', 'NOT_STARTED', 'ON_HOLD'] as const)(
      'does not render chip for status %s without committed dates (board / gutter handles them)',
      (status) => {
        renderWithRouter(
          <TaskListRow
            task={{ ...base, status, plannedStart: null }}
            level={1}
            widths={defaultWidths}
            visible={defaultVisible}
            {...defaultTreeProps}
          />,
        );
        expect(screen.queryByTestId('missing-dates-chip')).not.toBeInTheDocument();
      },
    );

    it('does not render chip on summary tasks (rollup, not data-integrity)', () => {
      renderWithRouter(
        <TaskListRow
          task={{ ...base, status: 'IN_PROGRESS', plannedStart: null, isSummary: true }}
          level={1}
          widths={defaultWidths}
          visible={defaultVisible}
          {...defaultTreeProps}
        />,
      );
      expect(screen.queryByTestId('missing-dates-chip')).not.toBeInTheDocument();
    });
  });
});

describe('TaskListRow — phase-in-waiting ghost affordance (issue #1754)', () => {
  it('does not render the hint by default', () => {
    renderWithRouter(
      <TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />,
    );
    expect(screen.queryByTestId('phase-in-waiting-hint')).not.toBeInTheDocument();
  });

  it('renders the "Add first item to this phase" hint when phaseInWaiting is true', () => {
    renderWithRouter(
      <TaskListRow
        task={base}
        level={1}
        widths={defaultWidths}
        visible={defaultVisible}
        {...defaultTreeProps}
        phaseInWaiting
      />,
    );
    const hint = screen.getByTestId('phase-in-waiting-hint');
    expect(hint).toBeInTheDocument();
    expect(hint).toHaveTextContent('Add first item to this phase');
    expect(hint).toHaveAccessibleName(`Add first item to ${base.name}`);
    // The tooltip is a THIRD distinct string renamed in the same hunk, and the
    // two assertions above cannot see it — the accessible name comes from
    // `aria-label`, which shadows both the text and the title.
    expect(hint).toHaveAttribute('title', 'This phase has no items yet');
  });

  it('clicking the hint calls onAddPhaseFirstChild with the task id', async () => {
    const user = userEvent.setup();
    const onAddPhaseFirstChild = vi.fn();
    renderWithRouter(
      <TaskListRow
        task={base}
        level={1}
        widths={defaultWidths}
        visible={defaultVisible}
        {...defaultTreeProps}
        phaseInWaiting
        onAddPhaseFirstChild={onAddPhaseFirstChild}
      />,
    );
    await user.click(screen.getByTestId('phase-in-waiting-hint'));
    expect(onAddPhaseFirstChild).toHaveBeenCalledWith(base.id);
  });
});

describe('TaskListRow — the row has an Open affordance (#2979)', () => {
  beforeEach(() => {
    useScheduleStore.setState({ selectedTaskId: null });
  });

  it('renders an Open button naming the task', () => {
    renderWithRouter(
      <TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />,
    );
    const open = screen.getByTestId('row-open-task');
    // The accessible name carries the task name: the button is icon-only, and a
    // bare "button" is indistinguishable from the thirty others on screen.
    expect(open).toHaveAccessibleName(`Open ${base.name}`);
    // Rule 287: an icon-only control's explanation is the shared `Tooltip`, never
    // a bare `title` — `title` is invisible to keyboard focus and unreachable on
    // touch. Asserting its ABSENCE is what stops a future edit reintroducing the
    // cheap version, which would still pass every other assertion here.
    expect(open).not.toHaveAttribute('title');
  });

  it('clicking it opens the task detail drawer', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />,
    );
    await user.click(screen.getByTestId('row-open-task'));
    expect(useScheduleStore.getState().selectedTaskId).toBe(base.id);
  });

  it('opens rather than toggles — a second click on an already-open row keeps it open', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />,
    );
    await user.click(screen.getByTestId('row-open-task'));
    await user.click(screen.getByTestId('row-open-task'));
    // The plain-Enter path toggles (`isSelected ? null : id`). This one must not,
    // or the button and the keyboard binding would disagree about what "Open" means.
    expect(useScheduleStore.getState().selectedTaskId).toBe(base.id);
  });

  it('is offered to a reader with no edit rights — opening a task is a read', () => {
    renderWithRouter(
      <TaskListRow
        task={{ ...base, canEdit: false }}
        level={1}
        widths={defaultWidths}
        visible={defaultVisible}
        {...defaultTreeProps}
      />,
    );
    // Web rule 302 removes what AUTHORS the plan, never what reads it. The row
    // menu is gated on authoring and is empty here — which is exactly why the
    // Open affordance could not live in it (#2979).
    expect(screen.getByTestId('row-open-task')).toBeInTheDocument();
  });

  it('is visible at rest on a coarse pointer — a hover reveal never fires on touch', () => {
    // Rule 287(a): `group-hover` does not exist on a touch device. Without this
    // branch the Open button would be permanently invisible on a tablet, which is
    // a supported Schedule surface — and a desktop review would never see it.
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('pointer: coarse'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
        dispatchEvent: vi.fn(),
      })),
    );
    try {
      renderWithRouter(
        <TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />,
      );
      const open = screen.getByTestId('row-open-task');
      expect(open.className).toContain('opacity-100');
      expect(open.className).not.toContain('opacity-0');
      // …and the tap target reaches 44px through the `before:` overlay rather
      // than by growing the icon, which would reflow the name cell.
      expect(open.className).toContain('before:inset-[-13px]');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Alt+Enter on the focused row opens the drawer', () => {
    renderWithRouter(
      <TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />,
    );
    fireEvent.keyDown(screen.getByRole('row'), { key: 'Enter', altKey: true });
    expect(useScheduleStore.getState().selectedTaskId).toBe(base.id);
  });

  it('plain Enter is NOT the open binding — it stays the selection toggle', () => {
    renderWithRouter(
      <TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />,
    );
    const row = screen.getByRole('row');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(useScheduleStore.getState().selectedTaskId).toBe(base.id);
    // …and toggles back off, which is the behavior Alt+Enter deliberately does
    // not copy. Asserting the difference here is what stops a future
    // "simplification" collapsing the two bindings into one.
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(useScheduleStore.getState().selectedTaskId).toBeNull();
  });
});

describe('TaskListRow — "N planned" badge (#1798)', () => {
  const summary: Task = { ...base, id: 'phase1', isSummary: true, name: 'Design Phase' };

  beforeEach(() => {
    useScheduleStore.setState({ revealGutterSprint: null });
  });

  it('renders the badge on a phase row when the subtree holds planned work', () => {
    renderWithRouter(
      <TaskListRow
        task={summary}
        level={1}
        widths={defaultWidths}
        visible={defaultVisible}
        {...defaultTreeProps}
        plannedBadge={{ count: 3, primarySprintId: 's1', sprintNames: ['Sprint 4'] }}
      />,
    );
    const badge = screen.getByTestId('planned-badge');
    expect(badge).toHaveTextContent('3 planned');
    // Single sprint → the honest "not a committed date" tooltip.
    expect(badge).toHaveAttribute('title', 'Planned for Sprint 4 — not a committed date');
  });

  it('does not render on a leaf task even if a badge is passed', () => {
    renderWithRouter(
      <TaskListRow
        task={base}
        level={2}
        widths={defaultWidths}
        visible={defaultVisible}
        {...defaultTreeProps}
        plannedBadge={{ count: 2, primarySprintId: 's1', sprintNames: ['Sprint 4'] }}
      />,
    );
    expect(screen.queryByTestId('planned-badge')).toBeNull();
  });

  it('does not render when the count is zero', () => {
    renderWithRouter(
      <TaskListRow
        task={summary}
        level={1}
        widths={defaultWidths}
        visible={defaultVisible}
        {...defaultTreeProps}
        plannedBadge={{ count: 0, primarySprintId: null, sprintNames: [] }}
      />,
    );
    expect(screen.queryByTestId('planned-badge')).toBeNull();
  });

  it('clicking requests the gutter reveal for the primary sprint', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <TaskListRow
        task={summary}
        level={1}
        widths={defaultWidths}
        visible={defaultVisible}
        {...defaultTreeProps}
        plannedBadge={{ count: 3, primarySprintId: 's1', sprintNames: ['Sprint 4'] }}
      />,
    );
    await user.click(screen.getByTestId('planned-badge'));
    expect(useScheduleStore.getState().revealGutterSprint?.sprintId).toBe('s1');
  });
});

/**
 * #3025 — a phase stated its child count only in a tooltip.
 *
 * Both strings existed and switched correctly on fold state, but only as a
 * `title` and an `aria-label`. So a sighted user had to hover the caret and wait
 * out the tooltip delay to learn how many rows were inside a phase, or whether a
 * collapsed phase held anything at all — an interaction unavailable on touch,
 * and precisely the one the design's "containment survives a fast visual scan"
 * premise exists to remove.
 *
 * The current tests passed on the attribute alone, which is why this shipped:
 * every assertion below is about *rendered text*.
 */
describe('TaskListRow — the row states its child count visibly (#3025)', () => {
  const phase: Task = { ...base, name: 'Mobilization', isSummary: true };

  function renderPhase(over: { isExpanded: boolean; childCount: number }) {
    renderWithRouter(
      <TaskListRow
        task={phase}
        level={1}
        widths={{ ...defaultWidths, task: 400 }}
        visible={defaultVisible}
        hasChildren
        onToggleId={vi.fn()}
        {...over}
      />,
    );
  }

  it('renders "4 inside" as text on an expanded phase, at rest with no hover', () => {
    renderPhase({ isExpanded: true, childCount: 4 });
    // getByText, not getByTitle / getByLabelText: the attribute was never the
    // defect, the absence of a visible form was.
    expect(screen.getByText('4 inside')).toBeInTheDocument();
  });

  it('renders "4 hidden" as text once the phase is folded', () => {
    renderPhase({ isExpanded: false, childCount: 4 });
    expect(screen.getByText('4 hidden')).toBeInTheDocument();
    expect(screen.queryByText('4 inside')).toBeNull();
  });

  it('uses the design’s exact words — not "children visible", not "collapsed"', () => {
    renderPhase({ isExpanded: true, childCount: 4 });
    expect(screen.queryByText(/children visible/)).toBeNull();
    expect(screen.queryByText(/4 items/)).toBeNull();
  });

  it('keeps the count on the caret’s accessible name, saying the same thing', () => {
    // "Keep the aria-label" — a screen-reader user still gets it from the
    // control, and the two forms are derived from one function so they cannot
    // drift into disagreeing about the same row.
    renderPhase({ isExpanded: true, childCount: 4 });
    expect(
      screen.getByRole('button', { name: 'Collapse Mobilization, 4 inside' }),
    ).toBeInTheDocument();
    expect(screen.getByText('4 inside')).toBeInTheDocument();
  });

  it('announces the count exactly once — the chip is a redundant encoding', () => {
    // The caret's accessible name already carries the phrase, and the caret is
    // the control the count describes. Two announcements per row would make a
    // 40-row plan read as 80 facts (rule 309(b)).
    renderPhase({ isExpanded: false, childCount: 4 });
    expect(screen.getByTestId('containment-count')).toHaveAttribute('aria-hidden', 'true');
  });

  it('drops the caret tooltip — the fact is on the row now, not behind a dwell', () => {
    renderPhase({ isExpanded: true, childCount: 4 });
    expect(screen.getByRole('button', { name: /Collapse Mobilization/ })).not.toHaveAttribute(
      'title',
    );
  });

  it('states the SUBTREE size, not the direct-child count', () => {
    // `childCountById` counts descendants, and that is the right number for both
    // fold states: folding hides the whole subtree, so a phase with two children
    // and two grandchildren really does hide four rows. A two-level fixture
    // cannot tell the two readings apart, which is how the prop's docstring
    // ("direct structural child count") drifted from what it carries.
    renderPhase({ isExpanded: false, childCount: 4 });
    expect(screen.getByText('4 hidden')).toBeInTheDocument();
    expect(screen.queryByText('2 hidden')).toBeNull();
  });

  it('a summary with children but a count of zero states nothing, and names nothing', () => {
    // Exactly the state the live outline was stuck in before this fix: the caret
    // rendered, `childCountById` never reached the panel, and every phase
    // announced itself with no count. A regression of that wiring lands back
    // here, and `/Collapse Mobilization/` would not notice — hence `exact`.
    renderPhase({ isExpanded: true, childCount: 0 });
    expect(screen.queryByTestId('containment-count')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Collapse Mobilization' }),
    ).toBeInTheDocument();
  });

  it('says nothing on a leaf row — "0 inside" is true of every task in the plan', () => {
    renderWithRouter(
      <TaskListRow
        task={base}
        level={2}
        widths={defaultWidths}
        visible={defaultVisible}
        {...defaultTreeProps}
      />,
    );
    expect(screen.queryByTestId('containment-count')).toBeNull();
  });

  it('states the count even with the WBS column hidden — it lives beside the name', () => {
    renderWithRouter(
      <TaskListRow
        task={phase}
        level={1}
        widths={{ ...defaultWidths, task: 400 }}
        visible={{ ...defaultVisible, wbs: false }}
        hasChildren
        childCount={4}
        isExpanded
        onToggleId={vi.fn()}
      />,
    );
    expect(screen.getByText('4 inside')).toBeInTheDocument();
  });
});

/**
 * #3026 — the lane is reserved by the panel, so a row holds it open whether or
 * not this particular reader may author.
 */
describe('TaskListRow — the nudge lane is the panel’s, not the row’s (#3026)', () => {
  it('holds the reserved lane open for a viewer, with no controls in it', () => {
    // A lane that exists only on editable rows is a table whose columns move
    // when the reader's rights do. Web rule 302 keeps the apparatus absent; the
    // lane keeps the columns aligned.
    renderWithRouter(
      <TaskListRow
        task={{ ...base, canEdit: false }}
        level={2}
        widths={defaultWidths}
        visible={defaultVisible}
        nudgeReserve={34}
        {...defaultTreeProps}
      />,
    );
    const lane = screen.getByTestId('row-structure-nudges');
    expect(lane.style.width).toBe('34px');
    expect(lane).toHaveAttribute('aria-hidden', 'true');
    // An empty lane is not a cell — a `role="row"` must not own a presentational
    // box, and a viewer's row would otherwise gain a gridcell an editor's has
    // content in (#2204).
    expect(lane).not.toHaveAttribute('role');
    expect(screen.queryByRole('button', { name: /Indent/ })).toBeNull();
  });

  it('renders NO lane at all when the panel reserved none', () => {
    // The third branch of `nudgeLane`. A zero-width box left in the row is not
    // the same as no box: it still joins the gridcell set and still answers a
    // `getByTestId`, so a regression that reserved 0 instead of omitting the
    // lane would be invisible to the assertion above.
    renderWithRouter(
      <TaskListRow
        task={{ ...base, canEdit: false }}
        level={2}
        widths={defaultWidths}
        visible={defaultVisible}
        nudgeReserve={0}
        {...defaultTreeProps}
      />,
    );
    expect(screen.queryByTestId('row-structure-nudges')).toBeNull();
  });
});
