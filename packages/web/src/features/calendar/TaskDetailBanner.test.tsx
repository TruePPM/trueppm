import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@/types';
import { TaskDetailBanner } from './CalendarView';

const baseTask = (overrides: Partial<Task> = {}): Task => ({
  id: 't1',
  wbs: '1',
  name: 'Integration Test',
  start: '2026-05-05',
  finish: '2026-05-08',
  duration: 4,
  progress: 0,
  parentId: null,
  isCritical: false,
  isComplete: false,
  isSummary: false,
  isMilestone: false,
  status: 'IN_PROGRESS',
  assignees: [],
  notes: '',
  ...overrides,
});

function renderBanner(task: Task, onClose = vi.fn()) {
  return render(
    <MemoryRouter>
      <TaskDetailBanner task={task} projectId="p1" onClose={onClose} />
    </MemoryRouter>,
  );
}

describe('TaskDetailBanner', () => {
  it('shows the task name and status label, not the raw UUID', () => {
    renderBanner(baseTask());
    expect(screen.getByText('Integration Test')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    // The bare id is never rendered as visible text.
    expect(screen.queryByText('t1')).not.toBeInTheDocument();
  });

  it('renders the date window for a multi-day task', () => {
    renderBanner(baseTask());
    expect(screen.getByText('May 5 – May 8')).toBeInTheDocument();
  });

  it('collapses a milestone to a single date', () => {
    renderBanner(
      baseTask({ isMilestone: true, start: '2026-05-07', finish: '2026-05-07', name: 'Launch' }),
    );
    expect(screen.getByText('May 7')).toBeInTheDocument();
  });

  it('lists assignees by name', () => {
    renderBanner(
      baseTask({
        assignees: [
          { resourceId: 'r1', name: 'Ada Lovelace', units: 1 },
          { resourceId: 'r2', name: 'Grace Hopper', units: 1 },
        ],
      }),
    );
    expect(screen.getByText('Ada Lovelace, Grace Hopper')).toBeInTheDocument();
  });

  it('shows "Unassigned" when there are no assignees', () => {
    renderBanner(baseTask({ assignees: [] }));
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
  });

  it('links to the full task detail route', () => {
    renderBanner(baseTask({ id: 'task-abc' }));
    const link = screen.getByRole('link', { name: 'Open full detail' });
    expect(link).toHaveAttribute('href', '/projects/p1/tasks/task-abc');
  });

  it('labels the region with the task name for screen readers', () => {
    renderBanner(baseTask({ name: 'Design phase' }));
    expect(screen.getByRole('region', { name: 'Task detail: Design phase' })).toBeInTheDocument();
  });

  it('fires onClose when Close is clicked', async () => {
    const onClose = vi.fn();
    renderBanner(baseTask(), onClose);
    await userEvent.click(screen.getByRole('button', { name: 'Close task detail' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
