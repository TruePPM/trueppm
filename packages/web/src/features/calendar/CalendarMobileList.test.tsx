import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@/types';
import { CalendarMobileList } from './CalendarMobileList';

const ANCHOR = '2026-05-01'; // May 2026

const task = (overrides: Partial<Task> = {}): Task => ({
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
  status: 'NOT_STARTED',
  assignees: [],
  notes: '',
  ...overrides,
});

describe('CalendarMobileList', () => {
  it('groups tasks that overlap the month under their start day', () => {
    render(
      <CalendarMobileList
        anchorIso={ANCHOR}
        tasks={[task(), task({ id: 't2', name: 'Later Task', start: '2026-05-20', finish: '2026-05-22' })]}
        onTaskClick={vi.fn()}
      />,
    );
    expect(screen.getByText('Integration Test')).toBeInTheDocument();
    expect(screen.getByText('Later Task')).toBeInTheDocument();
    // Two distinct day-group sections.
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2);
  });

  it('omits tasks whose span does not intersect the visible month', () => {
    render(
      <CalendarMobileList
        anchorIso={ANCHOR}
        tasks={[task({ id: 'past', name: 'Old Task', start: '2026-03-01', finish: '2026-03-05' })]}
        onTaskClick={vi.fn()}
      />,
    );
    expect(screen.queryByText('Old Task')).not.toBeInTheDocument();
  });

  it('names the empty month instead of rendering a blank agenda', () => {
    render(
      <CalendarMobileList
        anchorIso={ANCHOR}
        tasks={[task({ id: 'past', name: 'Old Task', start: '2026-03-01', finish: '2026-03-05' })]}
        onTaskClick={vi.fn()}
      />,
    );
    // Tasks exist in the project but none intersect May 2026.
    expect(screen.getByText(/No tasks in May 2026/)).toBeInTheDocument();
  });

  it('surfaces a task that started before the month under the first of the month', () => {
    render(
      <CalendarMobileList
        anchorIso={ANCHOR}
        tasks={[task({ id: 'span', name: 'Spanning Task', start: '2026-04-25', finish: '2026-05-10' })]}
        onTaskClick={vi.fn()}
      />,
    );
    expect(screen.getByText('Spanning Task')).toBeInTheDocument();
    // Clamped to the month-start day header.
    expect(screen.getByRole('heading', { name: /May 1/i })).toBeInTheDocument();
  });

  it('fires onTaskClick with the task id when a row is activated', async () => {
    const onTaskClick = vi.fn();
    render(<CalendarMobileList anchorIso={ANCHOR} tasks={[task()]} onTaskClick={onTaskClick} />);
    await userEvent.click(screen.getByRole('button', { name: /Integration Test/ }));
    expect(onTaskClick).toHaveBeenCalledWith('t1');
  });

  it('renders each row as a >=44px touch target', () => {
    render(<CalendarMobileList anchorIso={ANCHOR} tasks={[task()]} onTaskClick={vi.fn()} />);
    const row = screen.getByRole('button', { name: /Integration Test/ });
    expect(row.className).toContain('min-h-[44px]');
  });
});
