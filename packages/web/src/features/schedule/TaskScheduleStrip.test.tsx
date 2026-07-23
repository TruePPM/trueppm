import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task } from '@/types';
import { TaskScheduleStrip } from './TaskScheduleStrip';

// Mock the data hooks so the editable path needs no QueryClientProvider and we
// can assert on the exact PATCH payload / callback wiring (#2106).
type MutateOpts = { onSuccess?: () => void; onError?: (err: unknown) => void };
const mutate = vi.fn<(vars: unknown, opts?: MutateOpts) => void>();
const mutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate, mutateAsync }),
}));
let policy = 'keep';
vi.mock('@/hooks/useProject', () => ({
  useEffectiveDurationPolicy: () => policy,
}));
let coarse = false;
vi.mock('@/hooks/useIsCoarsePointer', () => ({
  useIsCoarsePointer: () => coarse,
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Stakeholder interviews',
    start: '2026-01-13',
    finish: '2026-01-28',
    // Committed by default (the normal case) so the #2314 "no committed start"
    // advisory does not render unless a test opts into the flag with
    // `plannedStart: null` — keeping the unrelated duration tests single-`status`.
    plannedStart: '2026-01-13',
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

  describe('editable Duration (#2106)', () => {
    beforeEach(() => {
      mutate.mockReset();
      mutateAsync.mockReset().mockResolvedValue(undefined);
      policy = 'keep';
      coarse = false;
    });
    afterEach(() => vi.restoreAllMocks());

    const editableProps = { projectId: 'p1', canEdit: true };

    it('renders Duration as an edit button only when projectId + canEdit are supplied', () => {
      const { rerender } = render(<TaskScheduleStrip task={makeTask()} />);
      // Read-only: a group, not a button.
      expect(screen.queryByRole('button', { name: /Duration/i })).not.toBeInTheDocument();

      rerender(<TaskScheduleStrip task={makeTask()} {...editableProps} />);
      expect(
        screen.getByRole('button', { name: /Duration, 12 days\. Edit\./ }),
      ).toBeInTheDocument();
    });

    it('a Viewer (canEdit false) sees the read-only Duration cell', () => {
      render(<TaskScheduleStrip task={makeTask()} projectId="p1" canEdit={false} />);
      expect(screen.queryByRole('button', { name: /Duration/i })).not.toBeInTheDocument();
      expect(
        within(screen.getByRole('group', { name: 'Duration' })).getByText('12d'),
      ).toBeInTheDocument();
    });

    it('milestones never render an editable duration even when editable', () => {
      render(<TaskScheduleStrip task={makeTask({ isMilestone: true })} {...editableProps} />);
      expect(screen.queryByRole('button', { name: /Duration/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Duration' })).not.toBeInTheDocument();
    });

    it('typing a new value and pressing Enter commits duration via PATCH', async () => {
      const user = userEvent.setup();
      mutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
      render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

      await user.click(screen.getByRole('button', { name: /Duration, 12 days/ }));
      const input = screen.getByRole('textbox', { name: 'Duration in days' });
      await user.clear(input);
      await user.type(input, '20');
      await user.keyboard('{Enter}');

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate.mock.calls[0][0]).toEqual({ id: 't1', projectId: 'p1', duration: 20 });
      // Commit announced on the live region.
      expect(screen.getByRole('status')).toHaveTextContent('Duration set to 20 days');
    });

    it('accepts the "2w" weeks shorthand (reuses parseDurationInput → 10)', async () => {
      const user = userEvent.setup();
      mutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
      render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

      await user.click(screen.getByRole('button', { name: /Duration, 12 days/ }));
      const input = screen.getByRole('textbox', { name: 'Duration in days' });
      await user.clear(input);
      await user.type(input, '2w{Enter}');

      expect(mutate.mock.calls[0][0]).toEqual({ id: 't1', projectId: 'p1', duration: 10 });
    });

    it('rejects invalid input inline without committing (rule 225)', async () => {
      const user = userEvent.setup();
      render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

      await user.click(screen.getByRole('button', { name: /Duration, 12 days/ }));
      const input = screen.getByRole('textbox', { name: 'Duration in days' });
      await user.clear(input);
      await user.type(input, 'abc{Enter}');

      expect(mutate).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(/whole number of days/i);
      // Stays in edit mode so the user can fix it.
      expect(screen.getByRole('textbox', { name: 'Duration in days' })).toBeInTheDocument();
    });

    it('Escape cancels the edit without committing', async () => {
      const user = userEvent.setup();
      render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

      await user.click(screen.getByRole('button', { name: /Duration, 12 days/ }));
      const input = screen.getByRole('textbox', { name: 'Duration in days' });
      await user.clear(input);
      await user.type(input, '99');
      await user.keyboard('{Escape}');

      expect(mutate).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /Duration, 12 days/ })).toBeInTheDocument();
    });

    it('surfaces the server span-cap message inline on a rejected PATCH (#1862)', async () => {
      const user = userEvent.setup();
      mutate.mockImplementation((_vars, opts) =>
        opts?.onError?.({ response: { data: { duration: ['Exceeds the project span.'] } } }),
      );
      render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

      await user.click(screen.getByRole('button', { name: /Duration, 12 days/ }));
      const input = screen.getByRole('textbox', { name: 'Duration in days' });
      await user.clear(input);
      await user.type(input, '9999{Enter}');

      expect(screen.getByRole('alert')).toHaveTextContent('Exceeds the project span.');
    });

    it('raises the Recalc %? prompt under the confirm policy when the task has progress', async () => {
      const user = userEvent.setup();
      policy = 'confirm';
      mutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
      render(<TaskScheduleStrip task={makeTask({ progress: 50 })} {...editableProps} />);

      await user.click(screen.getByRole('button', { name: /Duration, 12 days/ }));
      await user.clear(screen.getByRole('textbox', { name: 'Duration in days' }));
      await user.type(screen.getByRole('textbox', { name: 'Duration in days' }), '20{Enter}');

      expect(screen.getByTestId('recalc-percent-chip')).toBeInTheDocument();
    });

    it('suppresses the Recalc %? prompt on a coarse pointer (ADR-0151 confirm→keep on touch)', async () => {
      const user = userEvent.setup();
      policy = 'confirm';
      coarse = true;
      mutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
      render(<TaskScheduleStrip task={makeTask({ progress: 50 })} {...editableProps} />);

      await user.click(screen.getByRole('button', { name: /Duration, 12 days/ }));
      await user.clear(screen.getByRole('textbox', { name: 'Duration in days' }));
      await user.type(screen.getByRole('textbox', { name: 'Duration in days' }), '20{Enter}');

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('recalc-percent-chip')).not.toBeInTheDocument();
    });
  });

  describe('no-committed-start advisory (#2314)', () => {
    beforeEach(() => {
      mutate.mockReset();
      policy = 'keep';
      coarse = false;
    });
    afterEach(() => vi.restoreAllMocks());

    const editableProps = { projectId: 'p1', canEdit: true };
    // Flagged: IN_PROGRESS with no PM-committed plannedStart (CPM fills start).
    const flagged = () => makeTask({ status: 'IN_PROGRESS', plannedStart: null });

    it('renders the advisory with both remediations for an editable flagged task', () => {
      render(<TaskScheduleStrip task={flagged()} {...editableProps} />);
      expect(screen.getByText('No committed start')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Set committed start/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Move to To Do' })).toBeInTheDocument();
    });

    it('"Set committed start" PATCHes planned_start = the computed start', async () => {
      render(<TaskScheduleStrip task={flagged()} {...editableProps} />);
      await userEvent.click(screen.getByRole('button', { name: /Set committed start/i }));
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate).toHaveBeenCalledWith(
        { id: 't1', projectId: 'p1', planned_start: '2026-01-13' },
        expect.anything(),
      );
    });

    it('"Move to To Do" PATCHes status NOT_STARTED', async () => {
      render(<TaskScheduleStrip task={flagged()} {...editableProps} />);
      await userEvent.click(screen.getByRole('button', { name: 'Move to To Do' }));
      expect(mutate).toHaveBeenCalledWith(
        { id: 't1', projectId: 'p1', status: 'NOT_STARTED' },
        expect.anything(),
      );
    });

    it('does not render the advisory when the task is not flagged', () => {
      // NOT_STARTED (no flag) and IN_PROGRESS-but-committed both suppress it.
      const { rerender } = render(
        <TaskScheduleStrip task={makeTask({ status: 'NOT_STARTED', plannedStart: null })} {...editableProps} />,
      );
      expect(screen.queryByText('No committed start')).not.toBeInTheDocument();
      rerender(
        <TaskScheduleStrip
          task={makeTask({ status: 'IN_PROGRESS', plannedStart: '2026-01-13' })}
          {...editableProps}
        />,
      );
      expect(screen.queryByText('No committed start')).not.toBeInTheDocument();
    });

    it('marks the Start value as computed (sr-only qualifier) when flagged, in the read-only path too', () => {
      const { rerender } = render(<TaskScheduleStrip task={flagged()} />);
      expect(screen.getByText('(computed, not committed)')).toBeInTheDocument();
      // Committed start → no computed cue.
      rerender(<TaskScheduleStrip task={makeTask({ plannedStart: '2026-01-13' })} />);
      expect(screen.queryByText('(computed, not committed)')).not.toBeInTheDocument();
    });

    it('never marks a milestone Date as computed', () => {
      render(
        <TaskScheduleStrip
          task={makeTask({ isMilestone: true, status: 'IN_PROGRESS', plannedStart: null })}
        />,
      );
      expect(screen.queryByText('(computed, not committed)')).not.toBeInTheDocument();
    });
  });
});
