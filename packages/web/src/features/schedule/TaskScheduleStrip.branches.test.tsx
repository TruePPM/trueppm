import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DurationChangePercentPolicy } from '@/api/types';
import type { Task } from '@/types';
import { TaskScheduleStrip } from './TaskScheduleStrip';

/**
 * Branch-coverage companion to `TaskScheduleStrip.test.tsx`. The sibling spec
 * covers the golden paths; this one drives the guards, error paths, and the
 * false side of every conditional in the strip (#2459).
 */

type MutateOpts = { onSuccess?: () => void; onError?: (err: unknown) => void };
const mutate = vi.fn<(vars: unknown, opts?: MutateOpts) => void>();
const mutateAsync = vi.fn<(vars: unknown) => Promise<void>>();
vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate, mutateAsync }),
}));
let policy: DurationChangePercentPolicy = 'keep';
// The strip resolves the project's working-day length itself (#3042); it is only
// ever mounted under a QueryClient, so the hook is real in production and mocked
// here alongside the policy it already reads.
let projectHoursPerDay = 8;
// The server's own date, which the strip reads to disclose the date-gated
// NOT_STARTED → IN_PROGRESS promote before the user commits a start (#3075).
// `undefined` is the "project not loaded / older server" case, in which the labels
// must read exactly as they did before that disclosure existed.
let serverDate: string | undefined;
vi.mock('@/hooks/useProject', () => ({
  useEffectiveDurationPolicy: () => policy,
  useProjectHoursPerDay: () => projectHoursPerDay,
  useProject: () => ({ data: serverDate === undefined ? {} : { server_date: serverDate } }),
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

const editableProps = { projectId: 'p1', canEdit: true };

function durationButton(): HTMLElement {
  return screen.getByRole('button', { name: /^Duration,/ });
}

function durationInput(): HTMLElement {
  return screen.getByRole('textbox', { name: 'Duration in days' });
}

beforeEach(() => {
  mutate.mockReset();
  mutateAsync.mockReset().mockResolvedValue(undefined);
  policy = 'keep';
  coarse = false;
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

afterEach(() => {
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  vi.restoreAllMocks();
});

describe('TaskScheduleStrip — read-only cell rendering branches', () => {
  it('includes the year only for a date outside the current year', () => {
    render(<TaskScheduleStrip task={makeTask({ start: '2019-03-05', finish: '2019-03-20' })} />);
    const start = screen.getByRole('group', { name: 'Start' });
    expect(within(start).getByText('Mar 5, 2019')).toBeInTheDocument();

    // Same-year date drops the year segment entirely.
    const thisYear = `${new Date().getUTCFullYear()}-03-05`;
    render(<TaskScheduleStrip task={makeTask({ start: thisYear, finish: thisYear })} />);
    const starts = screen.getAllByRole('group', { name: 'Start' });
    expect(within(starts[1]).getByText('Mar 5')).toBeInTheDocument();
  });

  it('dashes the Finish cell too when the task has no schedule', () => {
    render(<TaskScheduleStrip task={makeTask({ start: '', finish: '' })} />);
    expect(
      within(screen.getByRole('group', { name: 'Finish' })).getByText('—'),
    ).toBeInTheDocument();
  });

  it('dashes a milestone Date cell when the milestone has no schedule', () => {
    render(<TaskScheduleStrip task={makeTask({ isMilestone: true, start: '', finish: '' })} />);
    expect(within(screen.getByRole('group', { name: 'Date' })).getByText('—')).toBeInTheDocument();
  });

  it('renders zero float as a value, not the no-float dash', () => {
    render(<TaskScheduleStrip task={makeTask({ totalFloat: 0 })} />);
    const float = screen.getByRole('group', { name: 'Float' });
    expect(within(float).getByText('0d')).toBeInTheDocument();
    expect(within(float).queryByText('—')).not.toBeInTheDocument();
  });

  it('renders the read-only Duration cell when projectId is missing even though canEdit is true', () => {
    render(<TaskScheduleStrip task={makeTask()} canEdit />);
    expect(screen.queryByRole('button', { name: /^Duration,/ })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Duration' })).getByText('12d'),
    ).toBeInTheDocument();
  });

  it('explains the Float jargon on hover but leaves Start/Finish unexplained', async () => {
    const user = userEvent.setup();
    render(<TaskScheduleStrip task={makeTask()} />);
    await user.hover(within(screen.getByRole('group', { name: 'Float' })).getByText('Float'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/float/i);

    await user.hover(within(screen.getByRole('group', { name: 'Start' })).getByText('Start'));
    // "Start" says what it means — no explanation attaches to it.
    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  });
});

describe('TaskScheduleStrip — DurationCell edit affordances', () => {
  it('enters edit mode from F2 and Space, but ignores an unrelated key', () => {
    render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

    fireEvent.keyDown(durationButton(), { key: 'a' });
    expect(screen.queryByRole('textbox', { name: 'Duration in days' })).not.toBeInTheDocument();

    fireEvent.keyDown(durationButton(), { key: 'F2' });
    expect(durationInput()).toBeInTheDocument();

    fireEvent.keyDown(durationInput(), { key: 'Escape' });
    fireEvent.keyDown(durationButton(), { key: ' ' });
    expect(durationInput()).toBeInTheDocument();
  });

  it('pluralizes the edit affordance label by the committed duration', () => {
    const { rerender } = render(
      <TaskScheduleStrip task={makeTask({ duration: 1 })} {...editableProps} />,
    );
    expect(screen.getByRole('button', { name: 'Duration, 1 day. Edit.' })).toBeInTheDocument();

    rerender(<TaskScheduleStrip task={makeTask({ duration: 2 })} {...editableProps} />);
    expect(screen.getByRole('button', { name: 'Duration, 2 days. Edit.' })).toBeInTheDocument();
  });

  it('reseeds the draft when the committed duration changes from outside while at rest', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);
    // A CPM/WebSocket update lands while the cell is not being edited.
    rerender(<TaskScheduleStrip task={makeTask({ duration: 30 })} {...editableProps} />);

    await user.click(durationButton());
    expect(durationInput()).toHaveValue('30');
  });

  it('keeps the pencil affordance permanently visible on a coarse pointer', () => {
    coarse = true;
    const { container, rerender } = render(
      <TaskScheduleStrip task={makeTask()} {...editableProps} />,
    );
    expect(container.querySelector('.opacity-100')).not.toBeNull();

    // Fine pointer: the pencil is faint at rest and strengthens on hover/focus.
    coarse = false;
    rerender(<TaskScheduleStrip task={makeTask({ id: 't2' })} {...editableProps} />);
    expect(container.querySelector('.opacity-40')).not.toBeNull();
  });

  it('returns focus to the cell button on an Enter exit and on an Escape exit', async () => {
    const user = userEvent.setup();
    mutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

    await user.click(durationButton());
    await user.clear(durationInput());
    await user.type(durationInput(), '20{Enter}');
    expect(durationButton()).toHaveFocus();

    await user.click(durationButton());
    await user.keyboard('{Escape}');
    expect(durationButton()).toHaveFocus();
  });

  it('leaves focus with the natural tab order when the edit exits via blur', async () => {
    const user = userEvent.setup();
    mutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

    await user.click(durationButton());
    await user.clear(durationInput());
    await user.type(durationInput(), '20');
    await user.click(screen.getByRole('group', { name: 'Start' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(durationButton()).not.toHaveFocus();
  });

  it('commits a valid value on blur', async () => {
    const user = userEvent.setup();
    mutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

    await user.click(durationButton());
    await user.clear(durationInput());
    await user.type(durationInput(), '7');
    await user.click(screen.getByRole('group', { name: 'Finish' }));

    expect(mutate.mock.calls[0][0]).toEqual({ id: 't1', projectId: 'p1', duration: 7 });
  });

  it('reverts to the committed value on a blur with unparseable input', async () => {
    const user = userEvent.setup();
    render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

    await user.click(durationButton());
    await user.clear(durationInput());
    await user.type(durationInput(), 'nonsense');
    await user.click(screen.getByRole('group', { name: 'Start' }));

    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/whole number of days/i);
    // The open input cannot be held across a blur — the cell returns to rest.
    expect(screen.queryByRole('textbox', { name: 'Duration in days' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Duration, 12 days. Edit.' })).toBeInTheDocument();
  });

  it('swallows the blur that follows an Enter so the edit is not committed twice', async () => {
    const user = userEvent.setup();
    render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

    await user.click(durationButton());
    await user.clear(durationInput());
    await user.type(durationInput(), 'abc{Enter}');
    // Enter kept the invalid input open for correction.
    expect(durationInput()).toBeInTheDocument();

    // The blur React fires while re-rendering must not re-run the commit — if it
    // did, the "revert on blur" path would close the cell out from under the user.
    fireEvent.blur(durationInput());
    expect(durationInput()).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('does not PATCH when the committed value is re-entered unchanged', async () => {
    const user = userEvent.setup();
    render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

    await user.click(durationButton());
    await user.keyboard('{Enter}');

    expect(mutate).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Duration in days' })).not.toBeInTheDocument();
  });

  it('clears a prior inline error when the cell is re-entered for editing', async () => {
    const user = userEvent.setup();
    render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

    await user.click(durationButton());
    await user.clear(durationInput());
    await user.type(durationInput(), 'abc{Enter}');
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await user.click(durationButton());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('flashes the commit tint and then settles back', async () => {
    const user = userEvent.setup();
    mutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

    await user.click(durationButton());
    await user.clear(durationInput());
    await user.type(durationInput(), '20{Enter}');
    // The flash tints the CELL (the grid item), not the inner value area — the
    // cell is what the user perceives flashing, and since #3211 it also holds
    // the unit picker row, which must flash with the rest of the cell.
    const flashed = () => durationButton().parentElement!;
    expect(flashed().className).toContain('bg-semantic-on-track-bg');

    await waitFor(() => expect(flashed().className).not.toContain('bg-semantic-on-track-bg'), {
      timeout: 3000,
    });
  });

  it('flashes the error tint and then settles back', async () => {
    const user = userEvent.setup();
    render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

    await user.click(durationButton());
    await user.clear(durationInput());
    await user.type(durationInput(), 'abc{Enter}');
    // Same as above: the tint is on the cell wrapper, not the inner group.
    const cell = () => screen.getByRole('group', { name: 'Duration' }).parentElement!;
    expect(cell().className).toContain('bg-semantic-critical-bg');

    await waitFor(() => expect(cell().className).not.toContain('bg-semantic-critical-bg'), {
      timeout: 3000,
    });
  });
});

describe('TaskScheduleStrip — duration commit guards and errors', () => {
  it('blocks the duration edit while offline instead of queuing a PATCH', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

    await user.click(durationButton());
    await user.clear(durationInput());
    await user.type(durationInput(), '20{Enter}');

    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      "You're offline — reconnect to change duration.",
    );
  });

  it('surfaces a bare string duration error from the server', async () => {
    const user = userEvent.setup();
    mutate.mockImplementation((_vars, opts) =>
      opts?.onError?.({ response: { data: { duration: 'Duration must be at least 1 day.' } } }),
    );
    render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

    await user.click(durationButton());
    await user.clear(durationInput());
    await user.type(durationInput(), '0{Enter}');

    expect(screen.getByRole('alert')).toHaveTextContent('Duration must be at least 1 day.');
  });

  it('falls back to a generic message when the error carries no duration detail', async () => {
    const user = userEvent.setup();
    mutate.mockImplementation((_vars, opts) => opts?.onError?.(new Error('Network Error')));
    render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

    await user.click(durationButton());
    await user.clear(durationInput());
    await user.type(durationInput(), '20{Enter}');

    expect(screen.getByRole('alert')).toHaveTextContent('Could not update the duration.');
  });

  it('falls back when the duration detail is a non-string array entry', async () => {
    const user = userEvent.setup();
    mutate.mockImplementation((_vars, opts) =>
      opts?.onError?.({ response: { data: { duration: [{ code: 'invalid' }] } } }),
    );
    render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

    await user.click(durationButton());
    await user.clear(durationInput());
    await user.type(durationInput(), '20{Enter}');

    expect(screen.getByRole('alert')).toHaveTextContent('Could not update the duration.');
  });

  it('announces a one-day commit in the singular', async () => {
    const user = userEvent.setup();
    mutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    render(<TaskScheduleStrip task={makeTask()} {...editableProps} />);

    await user.click(durationButton());
    await user.clear(durationInput());
    await user.type(durationInput(), '1{Enter}');

    expect(screen.getByRole('status')).toHaveTextContent(
      'Duration set to 1 day. Schedule updated.',
    );
  });
});

describe('TaskScheduleStrip — recalc-% prompt lifecycle', () => {
  async function commitUnderConfirmPolicy(user: ReturnType<typeof userEvent.setup>) {
    await user.click(durationButton());
    await user.clear(durationInput());
    await user.type(durationInput(), '20{Enter}');
  }

  it('re-PATCHes the prorated percent when the prompt is accepted', async () => {
    const user = userEvent.setup();
    policy = 'confirm';
    mutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    render(<TaskScheduleStrip task={makeTask({ progress: 50 })} {...editableProps} />);

    await commitUnderConfirmPolicy(user);
    await user.click(screen.getByRole('button', { name: /Recalculate percent complete to 30%/ }));

    expect(mutateAsync).toHaveBeenCalledWith({
      id: 't1',
      projectId: 'p1',
      percent_complete: 30,
    });
    expect(await screen.findByText('Set to 30%')).toBeInTheDocument();
  });

  it('removes the prompt when it is dismissed with Keep', async () => {
    const user = userEvent.setup();
    policy = 'confirm';
    mutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    render(<TaskScheduleStrip task={makeTask({ progress: 50 })} {...editableProps} />);

    await commitUnderConfirmPolicy(user);
    expect(screen.getByTestId('recalc-percent-chip')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Keep current percent complete' }));
    expect(screen.queryByTestId('recalc-percent-chip')).not.toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('never shows a prompt raised for a different task', async () => {
    const user = userEvent.setup();
    policy = 'confirm';
    mutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    const { rerender } = render(
      <TaskScheduleStrip task={makeTask({ progress: 50 })} {...editableProps} />,
    );

    await commitUnderConfirmPolicy(user);
    expect(screen.getByTestId('recalc-percent-chip')).toBeInTheDocument();

    // The drawer swaps to another task; the stale prompt must not follow it.
    rerender(<TaskScheduleStrip task={makeTask({ id: 't9', progress: 50 })} {...editableProps} />);
    expect(screen.queryByTestId('recalc-percent-chip')).not.toBeInTheDocument();
  });

  it('does not prompt when the policy is keep even with progress on the task', async () => {
    const user = userEvent.setup();
    policy = 'keep';
    mutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    render(<TaskScheduleStrip task={makeTask({ progress: 50 })} {...editableProps} />);

    await commitUnderConfirmPolicy(user);
    expect(screen.queryByTestId('recalc-percent-chip')).not.toBeInTheDocument();
  });

  it('does not prompt when the PATCH is rejected', async () => {
    const user = userEvent.setup();
    policy = 'confirm';
    mutate.mockImplementation((_vars, opts) => opts?.onError?.(new Error('nope')));
    render(<TaskScheduleStrip task={makeTask({ progress: 50 })} {...editableProps} />);

    await commitUnderConfirmPolicy(user);
    expect(screen.queryByTestId('recalc-percent-chip')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('TaskScheduleStrip — no-committed-start advisory branches', () => {
  const flagged = (overrides: Partial<Task> = {}) =>
    makeTask({ status: 'IN_PROGRESS', plannedStart: null, ...overrides });

  it('names the computed date in the remediation label when one exists', () => {
    render(<TaskScheduleStrip task={flagged()} {...editableProps} />);
    expect(
      screen.getByRole('button', { name: 'Set committed start (Jan 13)' }),
    ).toBeInTheDocument();
  });

  it('drops the date from the label when the task has no computed start', () => {
    render(<TaskScheduleStrip task={flagged({ start: '', finish: '' })} {...editableProps} />);
    expect(screen.getByRole('button', { name: 'Set committed start' })).toBeInTheDocument();
  });

  it('surfaces the offline guard when the advisory remediation is used offline', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    render(<TaskScheduleStrip task={flagged()} {...editableProps} />);

    await user.click(screen.getByRole('button', { name: /Set committed start/ }));

    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      "You're offline — reconnect to change the schedule.",
    );
  });

  it('surfaces a failed "Move to To Do" write inside the advisory', async () => {
    const user = userEvent.setup();
    mutate.mockImplementation((_vars, opts) => opts?.onError?.(new Error('500')));
    render(<TaskScheduleStrip task={flagged()} {...editableProps} />);

    await user.click(screen.getByRole('button', { name: 'Move to To Do' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not move the task to To Do. Try again.',
    );
  });

  it('does not render the advisory on the read-only path', () => {
    render(<TaskScheduleStrip task={flagged()} />);
    expect(screen.queryByText('No committed start')).not.toBeInTheDocument();
    // The computed-start cue still applies — only the remediation is editor-only.
    expect(screen.getByText('(computed, not committed)')).toBeInTheDocument();
  });

  it('does not flag a summary task that is missing a committed start', () => {
    render(<TaskScheduleStrip task={flagged({ isSummary: true })} {...editableProps} />);
    expect(screen.queryByText('No committed start')).not.toBeInTheDocument();
    expect(screen.queryByText('(computed, not committed)')).not.toBeInTheDocument();
  });
});
