import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Task } from '@/types';
import { TaskScheduleStrip } from './TaskScheduleStrip';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Stakeholder interviews',
    start: '2026-01-13',
    finish: '2026-01-28',
    duration: 12,
    progress: 40,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'IN_PROGRESS',
    readiness: 'ready',
    assignees: [],
    notes: '',
    totalFloat: 3,
    ...overrides,
  };
}

describe('TaskScheduleStrip', () => {
  it('renders Start / Finish / Duration / Float cells for a normal task', () => {
    render(<TaskScheduleStrip task={makeTask()} />);
    for (const label of ['Start', 'Finish', 'Duration', 'Float']) {
      expect(screen.getByRole('group', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByText('12d')).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Float' })).getByText('3d'),
    ).toBeInTheDocument();
  });

  it('shows the critical-path banner and CP marker only for a critical task', () => {
    const { rerender } = render(<TaskScheduleStrip task={makeTask({ isCritical: false })} />);
    expect(screen.queryByText(/On the critical path/i)).not.toBeInTheDocument();

    rerender(<TaskScheduleStrip task={makeTask({ isCritical: true, totalFloat: 0 })} />);
    expect(screen.getByText(/On the critical path/i)).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Float' })).getByText(/CP/),
    ).toBeInTheDocument();
  });

  it('relabels Start as "Date" and drops Finish/Duration for a milestone', () => {
    render(<TaskScheduleStrip task={makeTask({ isMilestone: true })} />);
    expect(screen.getByRole('group', { name: 'Date' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Start' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Finish' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Duration' })).not.toBeInTheDocument();
  });

  it('renders an em dash when the task has no schedule or float', () => {
    render(<TaskScheduleStrip task={makeTask({ start: '', finish: '', totalFloat: null })} />);
    const startCell = screen.getByRole('group', { name: 'Start' });
    expect(within(startCell).getByText('—')).toBeInTheDocument();
  });
});
