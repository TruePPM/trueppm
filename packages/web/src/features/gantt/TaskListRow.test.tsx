import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { useGanttStore } from '@/stores/ganttStore';
import { TaskListRow } from './TaskListRow';
import type { Task } from '@/types';
import type { ColumnWidths } from '@/hooks/useColumnWidths';

const defaultWidths: ColumnWidths['widths'] = {
  task: 180, dur: 52, start: 74, finish: 74, progress: 52,
};

const base: Task = {
  id: 't1', wbs: '1.1', name: 'Design Phase', start: '2026-10-05', finish: '2026-10-15',
  duration: 10, progress: 50, parentId: 't0',
  isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
  status: 'NOT_STARTED',
  assignees: [],
};

const defaultTreeProps = {
  hasChildren: false,
  isExpanded: false,
  onToggle: vi.fn(),
};

describe('TaskListRow', () => {
  beforeEach(() => {
    useGanttStore.setState({ selectedTaskId: null });
  });

  it('renders task name', () => {
    renderWithRouter(<TaskListRow task={base} level={2} widths={defaultWidths} {...defaultTreeProps} />);
    expect(screen.getByText('Design Phase')).toBeInTheDocument();
  });

  it('renders duration and progress', () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} {...defaultTreeProps} />);
    expect(screen.getByLabelText('10 days')).toBeInTheDocument();
    expect(screen.getByLabelText(/50% complete/i)).toBeInTheDocument();
  });

  it('renders duration without start date when unscheduled', () => {
    renderWithRouter(
      <TaskListRow task={{ ...base, start: '' }} level={1} widths={defaultWidths} />,
    );
    expect(screen.getByLabelText('10 days')).toBeInTheDocument();
    expect(screen.getByLabelText('unscheduled')).toBeInTheDocument();
  });

  it('critical task has aria-label mentioning critical path', () => {
    renderWithRouter(<TaskListRow task={{ ...base, isCritical: true }} level={1} widths={defaultWidths} {...defaultTreeProps} />);
    expect(screen.getByLabelText(/critical path/i)).toBeInTheDocument();
  });

  it('summary task applies font-medium style', () => {
    renderWithRouter(<TaskListRow task={{ ...base, isSummary: true }} level={1} widths={defaultWidths} />);
    const nameEl = screen.getByText('Design Phase');
    expect(nameEl.className).toContain('font-medium');
  });

  it('milestone shows diamond and hides duration/progress', () => {
    renderWithRouter(<TaskListRow task={{ ...base, isMilestone: true, duration: 0, progress: 0 }} level={1} widths={defaultWidths} {...defaultTreeProps} />);
    expect(screen.getByText('◆')).toBeInTheDocument();
    expect(screen.getByLabelText('milestone')).toBeInTheDocument();
  });

  it('clicking row selects it in the store', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} {...defaultTreeProps} />);
    await userEvent.click(screen.getByRole('row'));
    expect(useGanttStore.getState().selectedTaskId).toBe('t1');
  });

  it('clicking selected row deselects it', async () => {
    useGanttStore.setState({ selectedTaskId: 't1' });
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} {...defaultTreeProps} />);
    await userEvent.click(screen.getByRole('row'));
    expect(useGanttStore.getState().selectedTaskId).toBeNull();
  });

  it('Enter key toggles selection', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} />);
    const row = screen.getByRole('row');
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(useGanttStore.getState().selectedTaskId).toBe('t1');
  });

  it('Space key toggles selection', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} />);
    const row = screen.getByRole('row');
    row.focus();
    await userEvent.keyboard(' ');
    expect(useGanttStore.getState().selectedTaskId).toBe('t1');
  });

  it('F2 key enters edit mode', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} />);
    const row = screen.getByRole('row');
    row.focus();
    await userEvent.keyboard('{F2}');
    expect(screen.getByLabelText(/Rename task/i)).toBeInTheDocument();
  });

  it('double-click enters edit mode', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} />);
    await userEvent.dblClick(screen.getByRole('row'));
    expect(screen.getByLabelText(/Rename task/i)).toBeInTheDocument();
  });

  it('Escape cancels edit', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} />);
    await userEvent.dblClick(screen.getByRole('row'));
    const input = screen.getByLabelText(/Rename task/i);
    await userEvent.type(input, 'New Name');
    await userEvent.keyboard('{Escape}');
    // Should exit edit mode without renaming
    expect(screen.queryByLabelText(/Rename task/i)).not.toBeInTheDocument();
    expect(screen.getByText('Design Phase')).toBeInTheDocument();
  });

  it('Enter in edit mode commits the change', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} />);
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
        <TaskListRow task={base} level={1} widths={defaultWidths} />
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
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} />);
    const propBtn = screen.getByLabelText(/Open properties/i);
    await userEvent.click(propBtn);
    expect(useGanttStore.getState().selectedTaskId).toBe('t1');
  });

  it('renders assignee chips for non-summary non-milestone tasks', () => {
    const taskWithAssignees = {
      ...base,
      assignees: [
        { resourceId: 'r1', name: 'Alice', units: 100 },
        { resourceId: 'r2', name: 'Bob', units: 50 },
      ],
    };
    renderWithRouter(<TaskListRow task={taskWithAssignees} level={1} widths={defaultWidths} />);
    expect(screen.getByLabelText(/assigned to Alice, Bob/i)).toBeInTheDocument();
  });

  it('does not render assignee chips for summary tasks', () => {
    const summaryTask = {
      ...base,
      isSummary: true,
      assignees: [{ resourceId: 'r1', name: 'Alice', units: 100 }],
    };
    renderWithRouter(<TaskListRow task={summaryTask} level={1} widths={defaultWidths} />);
    // AssigneeChips should not render for summary tasks
    expect(screen.queryByText('A')).not.toBeInTheDocument();
  });

  it('clicking row during edit mode does not toggle selection', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} />);
    await userEvent.dblClick(screen.getByRole('row'));
    // Now in edit mode — click should not toggle selection
    expect(useGanttStore.getState().selectedTaskId).toBeNull();
  });

  it('keyboard events are ignored during edit mode', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} />);
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
        widths={defaultWidths}
        hasChildren={true}
        isExpanded={false}
        onToggle={toggleFn}
      />,
    );
    expect(screen.getByLabelText(/Expand Design Phase/i)).toBeInTheDocument();
  });

  it('chevron rotates when expanded', () => {
    renderWithRouter(
      <TaskListRow
        task={{ ...base, isSummary: true }}
        level={1}
        widths={defaultWidths}
        hasChildren={true}
        isExpanded={true}
        onToggle={vi.fn()}
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
        widths={defaultWidths}
        hasChildren={true}
        isExpanded={false}
        onToggle={toggleFn}
      />,
    );
    await userEvent.click(screen.getByLabelText(/Expand Design Phase/i));
    expect(toggleFn).toHaveBeenCalledTimes(1);
    // Should not toggle selection (stopPropagation)
    expect(useGanttStore.getState().selectedTaskId).toBeNull();
  });

  it('leaf tasks show spacer instead of chevron', () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} {...defaultTreeProps} />);
    expect(screen.queryByLabelText(/Expand/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Collapse/i)).not.toBeInTheDocument();
  });
});
