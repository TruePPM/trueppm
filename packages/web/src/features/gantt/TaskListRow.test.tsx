import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { useGanttStore } from '@/stores/ganttStore';
import { TaskListRow } from './TaskListRow';
import type { Task } from '@/types';
import type { ColumnWidths } from '@/hooks/useColumnWidths';

const defaultWidths: ColumnWidths['widths'] = {
  task: 180, durStart: 100, progress: 52,
};

const base: Task = {
  id: 't1', wbs: '1.1', name: 'Design Phase', start: '2026-10-05', finish: '2026-10-15',
  duration: 10, progress: 50, parentId: 't0',
  isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
  status: 'NOT_STARTED',
};

describe('TaskListRow', () => {
  beforeEach(() => {
    useGanttStore.setState({ selectedTaskId: null });
  });

  it('renders task name', () => {
    renderWithRouter(<TaskListRow task={base} level={2} widths={defaultWidths} />);
    expect(screen.getByText('Design Phase')).toBeInTheDocument();
  });

  it('renders duration and progress', () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} />);
    expect(screen.getByLabelText(/10 days/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/50% complete/i)).toBeInTheDocument();
  });

  it('critical task has aria-label mentioning critical path', () => {
    renderWithRouter(<TaskListRow task={{ ...base, isCritical: true }} level={1} widths={defaultWidths} />);
    expect(screen.getByLabelText(/critical path/i)).toBeInTheDocument();
  });

  it('milestone shows diamond and hides duration/progress', () => {
    renderWithRouter(<TaskListRow task={{ ...base, isMilestone: true, duration: 0, progress: 0 }} level={1} widths={defaultWidths} />);
    expect(screen.getByText('◆')).toBeInTheDocument();
  });

  it('clicking row selects it in the store', async () => {
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} />);
    await userEvent.click(screen.getByRole('row'));
    expect(useGanttStore.getState().selectedTaskId).toBe('t1');
  });

  it('clicking selected row deselects it', async () => {
    useGanttStore.setState({ selectedTaskId: 't1' });
    renderWithRouter(<TaskListRow task={base} level={1} widths={defaultWidths} />);
    await userEvent.click(screen.getByRole('row'));
    expect(useGanttStore.getState().selectedTaskId).toBeNull();
  });
});
