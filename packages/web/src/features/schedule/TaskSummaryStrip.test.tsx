import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TaskSummaryStrip } from './TaskSummaryStrip';
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

describe('TaskSummaryStrip', () => {
  it('shows the status label as text, not color alone', () => {
    render(<TaskSummaryStrip task={makeTask({ status: 'IN_PROGRESS' })} />);
    const status = screen.getByRole('group', { name: 'Status' });
    expect(within(status).getByText('In progress')).toBeInTheDocument();
  });

  it('renders the owner name and Unassigned fallback', () => {
    render(<TaskSummaryStrip task={makeTask()} />);
    expect(screen.getByText('Jane Smith')).toBeInTheDocument();

    render(<TaskSummaryStrip task={makeTask({ assignees: [] })} />);
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
  });

  it('shows an over-allocation note with an accessible reason', () => {
    render(<TaskSummaryStrip task={makeTask({ assigneeIsOverallocated: true })} />);
    expect(screen.getByText('over-allocated')).toBeInTheDocument();
    expect(
      screen.getByRole('note', { name: /Jane Smith is over-allocated/ }),
    ).toBeInTheDocument();
  });

  it('formats the finish date UTC-pinned and labels it Target finish when critical', () => {
    render(<TaskSummaryStrip task={makeTask({ finish: '2026-04-20', isCritical: true })} />);
    // Labeled "Target finish" (not "Finish") on a critical task.
    expect(screen.getByRole('group', { name: 'Target finish' })).toBeInTheDocument();
    expect(screen.getByText('Apr 20')).toBeInTheDocument();
  });

  it('shows the Critical flag with its word (not color alone) and hides the float chip', () => {
    render(<TaskSummaryStrip task={makeTask({ isCritical: true, totalFloat: 0 })} />);
    expect(screen.getByText(/Critical · 0d float/)).toBeInTheDocument();
    expect(screen.queryByText('0d float')).not.toBeInTheDocument();
  });

  it('shows the float chip when not critical', () => {
    render(<TaskSummaryStrip task={makeTask({ isCritical: false, totalFloat: 5 })} />);
    expect(screen.getByText('5d float')).toBeInTheDocument();
  });

  it('shows a Blocked flag from a human blocker reason', () => {
    render(<TaskSummaryStrip task={makeTask({ blockedReason: 'waiting on legal' })} />);
    expect(screen.getByText('Blocked')).toBeInTheDocument();
  });

  it('renders an em dash for an unscheduled finish', () => {
    render(<TaskSummaryStrip task={makeTask({ finish: '' })} />);
    const finish = screen.getByRole('group', { name: 'Finish' });
    expect(within(finish).getByText('—')).toBeInTheDocument();
  });
});
