import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  describe('read/edit split (#2424)', () => {
    it('does not render Status, Finish or Float — each is edited or computed below', () => {
      // The rule: the strip is the READ surface, the sections below are the EDIT
      // surface, and a value belongs to exactly one. Status is a select ~150px
      // down; Finish and Float are in the Schedule grid.
      render(<TaskSummaryStrip task={makeTask({ status: 'IN_PROGRESS', totalFloat: 5 })} />);
      expect(screen.queryByRole('group', { name: 'Status' })).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Finish' })).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Target finish' })).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Float' })).not.toBeInTheDocument();
      expect(screen.queryByText('In progress')).not.toBeInTheDocument();
      expect(screen.queryByText('5d float')).not.toBeInTheDocument();
    });

    it('declares itself read only', () => {
      render(<TaskSummaryStrip task={makeTask()} />);
      expect(screen.getByText('read only')).toBeInTheDocument();
    });

    it('keeps only the values carried nowhere else in the drawer', () => {
      // WBS lives in the drawer header and recent changes in DrawerRecentActivity
      // directly above, so re-rendering either here would be a new duplicate.
      render(<TaskSummaryStrip task={makeTask({ wbs: '1.1' })} />);
      expect(screen.getByRole('group', { name: 'Owner' })).toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Baseline' })).toBeInTheDocument();
      expect(screen.queryByText('1.1')).not.toBeInTheDocument();
    });
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
    expect(screen.getByRole('note', { name: /Jane Smith is over-allocated/ })).toBeInTheDocument();
  });

  describe('baseline chip', () => {
    it('pairs its tint with a signed day count, never color alone', () => {
      render(
        <TaskSummaryStrip
          task={makeTask({ finish: '2026-04-24', baselineFinish: '2026-04-20' })}
        />,
      );
      expect(screen.getByText('+4d')).toBeInTheDocument();
    });

    it('says so in words when the task is on baseline', () => {
      render(
        <TaskSummaryStrip
          task={makeTask({ finish: '2026-04-20', baselineFinish: '2026-04-20' })}
        />,
      );
      expect(screen.getByText('On baseline')).toBeInTheDocument();
    });

    it('reads "No baseline" when the task is not baselined', () => {
      render(<TaskSummaryStrip task={makeTask({ baselineFinish: undefined })} />);
      expect(screen.getByText('No baseline')).toBeInTheDocument();
    });
  });

  describe('FLAGS band', () => {
    it('does not render at all when there are no flags', () => {
      // Not an empty band, not a "No flags" placeholder, no reserved height.
      render(<TaskSummaryStrip task={makeTask({ totalFloat: 5 })} />);
      expect(screen.queryByRole('group', { name: 'Flags' })).not.toBeInTheDocument();
      expect(screen.queryByText('Flags')).not.toBeInTheDocument();
    });

    it('shows a Blocked flag from a human blocker reason', () => {
      render(<TaskSummaryStrip task={makeTask({ blockedReason: 'waiting on legal' })} />);
      expect(screen.getByRole('group', { name: 'Flags' })).toBeInTheDocument();
      expect(screen.getByText('Blocked')).toBeInTheDocument();
    });

    it('raises negative float as a real flag', () => {
      // The one float value that IS an exception: the task is already behind the
      // date the plan needs it to hold.
      render(<TaskSummaryStrip task={makeTask({ totalFloat: -3 })} />);
      expect(screen.getByText('Negative float -3d')).toBeInTheDocument();
    });

    it('does not treat plain positive float or critical-path membership as flags', () => {
      // Float is a metric every task has; the Schedule strip carries its own
      // critical banner. Either here would be a third copy.
      render(<TaskSummaryStrip task={makeTask({ isCritical: true, totalFloat: 0 })} />);
      expect(screen.queryByRole('group', { name: 'Flags' })).not.toBeInTheDocument();
    });
  });
});
