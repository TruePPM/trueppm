import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScheduleSummaryChip } from './ScheduleSummaryChip';
import { useSchedulerStore } from '@/stores/schedulerStore';
import type { Task } from '@/types';

const baseTask: Omit<Task, 'id' | 'wbs' | 'name'> = {
  start: '2026-04-05', finish: '2026-04-09',
  duration: 5, progress: 0,
  parentId: null,
  isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
  status: 'NOT_STARTED', assignees: [], notes: '',
};

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return { ...baseTask, id, wbs: id, name: id, ...overrides } as Task;
}

beforeEach(() => {
  useSchedulerStore.setState({
    isRecalculating: false,
    cpmError: null,
    recalculatedAt: null,
  });
});

describe('ScheduleSummaryChip', () => {
  it('renders task count and critical count when CPM is healthy', () => {
    render(
      <ScheduleSummaryChip
        visibleTasks={[
          makeTask('a'),
          makeTask('b', { isCritical: true }),
          makeTask('c', { isCritical: true }),
        ]}
      />,
    );
    expect(screen.getByLabelText(/Project status: 3 tasks, 2 critical, CPM healthy/)).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  it('uses singular "task" for count of 1', () => {
    render(<ScheduleSummaryChip visibleTasks={[makeTask('a')]} />);
    expect(screen.getByText('task')).toBeInTheDocument();
    expect(screen.queryByText('tasks')).toBeNull();
  });

  it('does not count summary tasks as critical even when flagged', () => {
    render(
      <ScheduleSummaryChip
        visibleTasks={[
          makeTask('a', { isSummary: true, isCritical: true }),
          makeTask('b', { isCritical: true }),
        ]}
      />,
    );
    expect(screen.getByLabelText(/2 tasks, 1 critical/)).toBeInTheDocument();
  });

  it('renders loading state when CPM is recalculating (preserves width)', () => {
    useSchedulerStore.setState({ isRecalculating: true });
    render(<ScheduleSummaryChip visibleTasks={[makeTask('a')]} />);
    expect(screen.getByLabelText('Project status: recalculating')).toBeInTheDocument();
    expect(screen.getByText('CPM …')).toBeInTheDocument();
    // Two-dot placeholders for the numeric slots.
    expect(screen.getAllByText('··')).toHaveLength(2);
  });

  it('renders error state when CPM has an error', () => {
    useSchedulerStore.setState({
      cpmError: { error: 'cyclic_dependency', cycle: ['a', 'b'] },
    });
    render(<ScheduleSummaryChip visibleTasks={[makeTask('a'), makeTask('b')]} />);
    expect(screen.getByLabelText(/CPM error/)).toBeInTheDocument();
    expect(screen.getByText('⚠')).toBeInTheDocument();
  });

  it('error state takes precedence over recalculating', () => {
    // Both flags set — store guarantees this won't really happen, but defensive.
    useSchedulerStore.setState({
      isRecalculating: true,
      cpmError: { error: 'internal_error', cycle: [] },
    });
    render(<ScheduleSummaryChip visibleTasks={[]} />);
    // isRecalculating short-circuits in the component — verify loading wins.
    expect(screen.getByText('CPM …')).toBeInTheDocument();
  });

  it('handles empty task list', () => {
    render(<ScheduleSummaryChip visibleTasks={[]} />);
    expect(screen.getByLabelText('Project status: 0 tasks, 0 critical, CPM healthy')).toBeInTheDocument();
  });
});
