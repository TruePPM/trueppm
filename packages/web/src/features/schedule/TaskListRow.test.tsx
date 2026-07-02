import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { useScheduleStore } from '@/stores/scheduleStore';
import { TaskListRow, truncateWbsPath } from './TaskListRow';
import type { Task } from '@/types';
import type { ColumnWidths } from '@/hooks/useColumnWidths';

const defaultWidths: ColumnWidths['widths'] = {
  wbs: 48, task: 180, dur: 52, start: 74, finish: 74, progress: 52, owner: 72,
};

const defaultVisible: ColumnWidths['visible'] = {
  wbs: true, task: true, dur: true, start: true, finish: true, progress: true, owner: true,
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
    expect(screen.getByLabelText(/Owner: Alice, Bob/i)).toBeInTheDocument();
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

  it('summary task applies font-medium style', () => {
    renderWithRouter(<TaskListRow task={{ ...base, isSummary: true }} level={1} widths={defaultWidths} visible={defaultVisible} />);
    const nameEl = screen.getByText('Design Phase');
    expect(nameEl.className).toContain('font-medium');
  });

  it('milestone shows diamond and hides duration/progress', () => {
    renderWithRouter(<TaskListRow task={{ ...base, isMilestone: true, duration: 0, progress: 0 }} level={1} widths={defaultWidths} visible={defaultVisible} {...defaultTreeProps} />);
    expect(screen.getByText('◆')).toBeInTheDocument();
    expect(screen.getByLabelText('milestone')).toBeInTheDocument();
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
    expect(screen.getByLabelText(/Rename task/i)).toBeInTheDocument();
  });

  it('double-click enters edit mode', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} />);
    await userEvent.dblClick(screen.getByRole('row'));
    expect(screen.getByLabelText(/Rename task/i)).toBeInTheDocument();
  });

  it('Escape cancels edit', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} />);
    await userEvent.dblClick(screen.getByRole('row'));
    const input = screen.getByLabelText(/Rename task/i);
    await userEvent.type(input, 'New Name');
    await userEvent.keyboard('{Escape}');
    // Should exit edit mode without renaming
    expect(screen.queryByLabelText(/Rename task/i)).not.toBeInTheDocument();
    expect(screen.getByText('Design Phase')).toBeInTheDocument();
  });

  it('Enter in edit mode commits the change', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} />);
    await userEvent.dblClick(screen.getByRole('row'));
    const input = screen.getByLabelText(/Rename task/i);
    await userEvent.clear(input);
    await userEvent.type(input, 'Updated Name');
    await userEvent.keyboard('{Enter}');
    // Should exit edit mode
    expect(screen.queryByLabelText(/Rename task/i)).not.toBeInTheDocument();
  });

  it('blur commits edit', async () => {
    renderWithRouter(
      <div>
        <TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} />
        <button type="button">Other</button>
      </div>,
    );
    await userEvent.dblClick(screen.getByRole('row'));
    const input = screen.getByLabelText(/Rename task/i);
    await userEvent.clear(input);
    await userEvent.type(input, 'Blur Name');
    await userEvent.click(screen.getByText('Other'));
    expect(screen.queryByLabelText(/Rename task/i)).not.toBeInTheDocument();
  });

  it('properties button selects the task', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} />);
    const propBtn = screen.getByLabelText(/Open properties/i);
    await userEvent.click(propBtn);
    expect(useScheduleStore.getState().selectedTaskId).toBe('t1');
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
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} visible={defaultVisible} />);
    await userEvent.dblClick(screen.getByRole('row'));
    const input = screen.getByLabelText(/Rename task/i);
    // Enter in input commits, Space types a space
    await userEvent.type(input, ' extra');
    expect(input).toHaveValue('Design Phase extra');
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
        expect(screen.getByLabelText('Missing schedule dates')).toBeInTheDocument();
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
