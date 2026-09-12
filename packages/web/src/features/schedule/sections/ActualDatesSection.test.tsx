import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';

import type { Task } from '@/types';
import { ROLE_MEMBER, ROLE_VIEWER } from '@/lib/roles';
import { ActualDatesSection } from './ActualDatesSection';

/** The PATCH payload shape `ActualDatesSection` hands to `useUpdateTask().mutate`. */
type UpdateTaskVars = {
  id: string;
  projectId: string;
  actual_start?: string | null;
  actual_finish?: string | null;
};
type MutateOptions = { onSuccess?: () => void; onError?: (err: unknown) => void };

const mutate = vi.fn<(vars: UpdateTaskVars, options?: MutateOptions) => void>();

function lastMutate(): { vars: UpdateTaskVars; options: MutateOptions | undefined } {
  const call = mutate.mock.calls.at(-1);
  if (!call) throw new Error('updateTask was never called');
  return { vars: call[0], options: call[1] };
}

vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate, isPending: false }),
}));

let TASKS: Partial<Task>[] = [];
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: TASKS }),
}));

function setTask(over: Partial<Task>) {
  TASKS = [{ id: 'task-1', name: 'Build login', status: 'COMPLETE', ...over }];
}

function renderSection(props: Partial<Parameters<typeof ActualDatesSection>[0]> = {}) {
  return render(
    <ActualDatesSection
      taskId="task-1"
      projectId="proj-1"
      userRole={ROLE_MEMBER}
      canEdit
      {...props}
    />,
  );
}

const startInput = () => screen.getByLabelText<HTMLInputElement>('Actual start');
const finishInput = () => screen.getByLabelText<HTMLInputElement>('Actual finish');

/** A DRF 400 as the api client surfaces it, for the `onError` path. */
function drfError(field: string, message: string) {
  return { response: { data: { [field]: [message] } } };
}

beforeEach(() => {
  mutate.mockClear();
  TASKS = [];
});

describe('ActualDatesSection', () => {
  it('renders the stored actuals', () => {
    setTask({ actualStart: '2026-04-01', actualFinish: '2026-04-10' });
    renderSection();
    expect(startInput().value).toBe('2026-04-01');
    expect(finishInput().value).toBe('2026-04-10');
  });

  it('PATCHes the snake_case field on edit', () => {
    setTask({ actualStart: '2026-04-01', actualFinish: '2026-04-10' });
    renderSection();
    fireEvent.change(finishInput(), { target: { value: '2026-04-12' } });
    expect(lastMutate().vars).toMatchObject({
      id: 'task-1',
      projectId: 'proj-1',
      actual_finish: '2026-04-12',
    });
  });

  it('clearing a field sends null, not an empty string', () => {
    setTask({ actualStart: '2026-04-01', actualFinish: '2026-04-10' });
    renderSection();
    fireEvent.change(startInput(), { target: { value: '' } });
    expect(lastMutate().vars.actual_start).toBeNull();
  });

  it('pre-checks ordering client-side and does not PATCH', () => {
    setTask({ actualStart: '2026-04-01', actualFinish: '2026-04-10' });
    renderSection();
    fireEvent.change(finishInput(), { target: { value: '2026-03-01' } });

    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Actual finish cannot be earlier than actual start (2026-04-01).',
    );
  });

  it('catches the ordering violation from the start side too', () => {
    setTask({ actualStart: '2026-04-01', actualFinish: '2026-04-10' });
    renderSection();
    fireEvent.change(startInput(), { target: { value: '2026-04-20' } });

    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('cannot be earlier than actual start');
  });

  it('surfaces the server message verbatim on a 400 and keeps the typed value', () => {
    // mapTask normalizes the server's null to undefined, so that is the absent shape.
    setTask({ actualStart: undefined, actualFinish: '2026-04-10' });
    renderSection();
    fireEvent.change(finishInput(), { target: { value: '2027-01-01' } });

    // The future bound needs the project data date, so the client does not guess it —
    // the write goes out and the server's own sentence comes back.
    expect(mutate).toHaveBeenCalledTimes(1);
    act(() => {
      lastMutate().options?.onError?.(
        drfError('actual_finish', 'Actual finish cannot be in the future (after 2026-09-11).'),
      );
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Actual finish cannot be in the future (after 2026-09-11).',
    );
    // The rejected value stays in the field so the user can correct it, not retype it.
    expect(finishInput().value).toBe('2027-01-01');
  });

  it('falls back to generic copy when the failure is not a field validation error', () => {
    setTask({ actualFinish: '2026-04-10' });
    renderSection();
    fireEvent.change(finishInput(), { target: { value: '2026-04-12' } });
    act(() => lastMutate().options?.onError?.(new Error('Network down')));

    expect(screen.getByRole('alert')).toHaveTextContent('Could not save that date');
  });

  it('drops the draft on success so the server value governs', () => {
    setTask({ actualStart: '2026-04-01', actualFinish: '2026-04-10' });
    renderSection();
    fireEvent.change(finishInput(), { target: { value: '2026-04-12' } });
    act(() => lastMutate().options?.onSuccess?.());

    // TASKS still holds the pre-write value; with the draft dropped, that is what shows.
    expect(finishInput().value).toBe('2026-04-10');
  });

  it('an error on one field does not surface on the other', () => {
    setTask({ actualStart: '2026-04-01', actualFinish: '2026-04-10' });
    renderSection();
    fireEvent.change(finishInput(), { target: { value: '2026-04-12' } });
    act(() => lastMutate().options?.onError?.(drfError('actual_finish', 'Nope.')));

    // Both inputs share one useUpdateTask instance — the error must stay keyed to the
    // field that produced it, or the section states task A's refusal about field B.
    expect(finishInput()).toHaveAttribute('aria-invalid', 'true');
    expect(startInput()).not.toHaveAttribute('aria-invalid');
  });

  describe('sign-off gate', () => {
    it.each(['REVIEW', 'COMPLETE'] as const)('enables actual finish in %s', (status) => {
      setTask({ status });
      renderSection();
      expect(finishInput()).not.toHaveAttribute('readonly');
      expect(screen.queryByText(/moves to In review or Complete/)).not.toBeInTheDocument();
    });

    it.each(['BACKLOG', 'NOT_STARTED', 'IN_PROGRESS'] as const)(
      'makes actual finish inert in %s, with a reachable explanation',
      (status) => {
        setTask({ status });
        renderSection();
        // readOnly, NOT disabled (web-rule 302 + the aria-describedby reachability
        // argument in the component docstring): a disabled input leaves the tab order
        // and takes its explanation with it.
        expect(finishInput()).toHaveAttribute('readonly');
        expect(finishInput()).not.toBeDisabled();
        const help = screen.getByText('Set when the task moves to In review or Complete.');
        expect(help).toBeInTheDocument();
        expect(finishInput().getAttribute('aria-describedby')).toBe(help.id);
        // actual_start carries no status gate — ADR-0136 keeps it the permissive half.
        expect(startInput()).not.toHaveAttribute('readonly');
      },
    );
  });

  it('renders NO authoring apparatus without edit rights, but keeps the values', () => {
    setTask({ status: 'COMPLETE', actualStart: '2026-04-01', actualFinish: '2026-04-10' });
    renderSection({ canEdit: false, userRole: ROLE_VIEWER });

    // web-rule 302: no rights ⇒ the apparatus is ABSENT, not disabled. A disabled
    // control announces "[label], dimmed" and, being out of the tab order, hides the
    // value from a keyboard/screen-reader user who is entitled to read it.
    expect(screen.queryByLabelText('Actual start')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Actual finish')).not.toBeInTheDocument();
    expect(screen.getByText('2026-04-01')).toBeInTheDocument();
    expect(screen.getByText('2026-04-10')).toBeInTheDocument();
    expect(screen.getByText('Actual dates are read-only for your role.')).toBeInTheDocument();
  });

  it('shows an em-dash, not a blank, for an unrecorded date without edit rights', () => {
    setTask({ status: 'COMPLETE', actualStart: undefined, actualFinish: '2026-04-10' });
    renderSection({ canEdit: false, userRole: ROLE_VIEWER });
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('prefers the server canEdit verdict over the client role rule', () => {
    setTask({ status: 'COMPLETE' });
    // A Viewer role that the server nonetheless says may edit (ADR-0133/1142).
    renderSection({ canEdit: true, userRole: ROLE_VIEWER });
    expect(startInput()).not.toHaveAttribute('readonly');
  });

  it('never presents a missing actual start as a problem (ADR-0136)', () => {
    setTask({ status: 'COMPLETE', actualStart: undefined, actualFinish: '2026-04-10' });
    renderSection();

    expect(startInput().value).toBe('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(startInput()).not.toHaveAttribute('aria-invalid');
    // The explanatory line says the half-populated shape is normal, not a gap.
    expect(screen.getByText(/A finish with no start is\s+normal/)).toBeInTheDocument();
  });

  it('renders nothing when the task is not in the loaded list', () => {
    TASKS = [];
    const { container } = renderSection();
    expect(container).toBeEmptyDOMElement();
  });
});
