import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskDrawerHeader } from './TaskDrawerHeader';
import type { Task } from '@/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    name: 'Design sprint',
    start: '2026-04-06',
    finish: '2026-04-20',
    duration: 14,
    progress: 50,
    isSummary: false,
    isMilestone: false,
    isCritical: false,
    isComplete: false,
    parentId: null,
    wbs: '1.1',
    status: 'IN_PROGRESS',
    assignees: [{ resourceId: 'r1', name: 'Jane Smith', units: 1 }],
    totalFloat: 5,
    ...overrides,
  } as unknown as Task;
}

describe('TaskDrawerHeader', () => {
  it('renders assignee name', () => {
    render(<TaskDrawerHeader task={makeTask()} />);
    expect(screen.getByText('Jane Smith')).toBeInTheDocument();
  });

  it('renders "Unassigned" when task has no assignees', () => {
    render(<TaskDrawerHeader task={makeTask({ assignees: [] })} />);
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
  });

  it('renders over-allocated pill when assigneeIsOverallocated is true', () => {
    render(
      <TaskDrawerHeader
        task={makeTask({ assigneeIsOverallocated: true })}
      />,
    );
    expect(screen.getByText('⚠ over-allocated')).toBeInTheDocument();
  });

  it('does not render over-allocated pill when assigneeIsOverallocated is false', () => {
    render(
      <TaskDrawerHeader
        task={makeTask({ assigneeIsOverallocated: false })}
      />,
    );
    expect(screen.queryByText('⚠ over-allocated')).toBeNull();
  });

  it('renders start and finish dates', () => {
    render(<TaskDrawerHeader task={makeTask()} />);
    // Apr 6 → Apr 20 (current year 2026)
    expect(screen.getByText(/Apr 6/)).toBeInTheDocument();
    expect(screen.getByText(/Apr 20/)).toBeInTheDocument();
  });

  it('renders baseline dates when present', () => {
    render(
      <TaskDrawerHeader
        task={makeTask({ baselineStart: '2026-04-04', baselineFinish: '2026-04-18' })}
      />,
    );
    expect(screen.getByText(/BL:/)).toBeInTheDocument();
  });

  it('does not render baseline row when baseline is absent', () => {
    render(<TaskDrawerHeader task={makeTask({ baselineStart: undefined, baselineFinish: undefined })} />);
    expect(screen.queryByText(/BL:/)).toBeNull();
  });

  it('renders float value', () => {
    render(<TaskDrawerHeader task={makeTask({ totalFloat: 3 })} />);
    expect(screen.getByText('3d float')).toBeInTheDocument();
  });

  it('renders critical path indicator for critical tasks with 0 float', () => {
    render(
      <TaskDrawerHeader
        task={makeTask({ isCritical: true, totalFloat: 0 })}
      />,
    );
    expect(screen.getByText('0d float')).toBeInTheDocument();
    expect(screen.getByText('· critical path')).toBeInTheDocument();
  });

  it('renders "Not scheduled" when task has no start date', () => {
    render(<TaskDrawerHeader task={makeTask({ start: '' })} />);
    expect(screen.getByText('Not scheduled')).toBeInTheDocument();
  });

  it('renders "Float pending" when totalFloat is null', () => {
    render(<TaskDrawerHeader task={makeTask({ totalFloat: null })} />);
    expect(screen.getByText(/Float pending/)).toBeInTheDocument();
  });
});
