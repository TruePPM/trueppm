/**
 * MobileSchedule unit tests (#1671, ADR-0348).
 *
 * Covers:
 *  - scheduled tasks render as rows; a row tap sets scheduleStore.selectedTaskId
 *    (the shared TaskDetailDrawer open path)
 *  - one-tap complete issues the toggle PATCH { status: 'COMPLETE' }
 *  - the Unscheduled tray shows only when there are unscheduled tasks
 *  - loading / error / empty / not-scheduled states each render
 *  - a critical row exposes the critical state in its accessible name
 */
import type { ComponentProps } from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '@/types';
import { useScheduleStore } from '@/stores/scheduleStore';
import { MobileSchedule } from './MobileSchedule';

const { patchMock } = vi.hoisted(() => ({
  patchMock: vi.fn().mockResolvedValue({ data: {} }),
}));

vi.mock('@/api/client', () => ({
  apiClient: { patch: patchMock },
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Task',
    start: '2026-08-01',
    finish: '2026-08-08',
    plannedStart: '2026-08-01',
    duration: 7,
    progress: 40,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'IN_PROGRESS',
    canEdit: true,
    assignees: [],
    notes: '',
    ...overrides,
  };
}

const noop = () => {};

function renderSchedule(props: Partial<ComponentProps<typeof MobileSchedule>> = {}) {
  return render(
    <MobileSchedule
      tasks={[]}
      projectId="p1"
      readOnly={false}
      isLoading={false}
      error={null}
      onAddTask={noop}
      {...props}
    />,
  );
}

beforeEach(() => {
  patchMock.mockClear();
  useScheduleStore.setState({ selectedTaskId: null });
});

describe('MobileSchedule', () => {
  it('renders scheduled tasks as rows and opens the drawer on row tap', () => {
    const task = makeTask({ id: 'row-1', name: 'Wire cladding panels' });
    renderSchedule({ tasks: [task] });

    // Row's accessible name carries name + status + dates.
    const row = screen.getByRole('button', { name: /Wire cladding panels, In progress/ });
    fireEvent.click(row);

    expect(useScheduleStore.getState().selectedTaskId).toBe('row-1');
  });

  it('one-tap complete issues the toggle PATCH', async () => {
    const task = makeTask({ id: 'row-2', name: 'Excavate', status: 'IN_PROGRESS' });
    renderSchedule({ tasks: [task] });

    fireEvent.click(screen.getByRole('button', { name: /Mark Excavate complete/i }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/tasks/row-2/', { status: 'COMPLETE' }),
    );
    // The row-open path must NOT fire when the complete control is tapped.
    expect(useScheduleStore.getState().selectedTaskId).toBeNull();
  });

  it('surfaces the critical state in the row accessible name', () => {
    renderSchedule({ tasks: [makeTask({ name: 'Pour foundation', isCritical: true })] });
    expect(
      screen.getByRole('button', { name: /Pour foundation.*on the critical path/ }),
    ).toBeInTheDocument();
  });

  it('shows the Unscheduled tray with a count only when there are unscheduled tasks', () => {
    const scheduled = makeTask({ id: 's', name: 'Scheduled work' });
    const unscheduled = makeTask({
      id: 'u',
      name: 'Backlog item',
      status: 'NOT_STARTED',
      plannedStart: null,
      start: '',
      finish: '',
    });
    renderSchedule({ tasks: [scheduled, unscheduled] });

    const tray = screen.getByRole('button', { name: /Unscheduled/ });
    expect(tray).toHaveAttribute('aria-expanded');
    // The unscheduled task is reachable (tray auto-expands on first appearance).
    expect(screen.getByRole('button', { name: /Backlog item, unscheduled/ })).toBeInTheDocument();
  });

  it('does not render the tray when nothing is unscheduled', () => {
    renderSchedule({ tasks: [makeTask()] });
    expect(screen.queryByRole('button', { name: /Unscheduled/ })).not.toBeInTheDocument();
  });

  it('renders the loading skeleton while the query is in flight', () => {
    renderSchedule({ isLoading: true });
    expect(screen.getByLabelText('Loading schedule')).toBeInTheDocument();
  });

  it('renders the error state', () => {
    renderSchedule({ error: new Error('boom') });
    expect(screen.getByText("Couldn't load the schedule")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
  });

  it('renders the empty state when there are no tasks', () => {
    renderSchedule({ tasks: [] });
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
  });

  it('renders the not-scheduled state when every task is unscheduled', () => {
    const unscheduled = makeTask({
      id: 'u',
      status: 'NOT_STARTED',
      plannedStart: null,
      start: '',
      finish: '',
    });
    renderSchedule({ tasks: [unscheduled] });
    expect(screen.getByText('Not scheduled yet')).toBeInTheDocument();
  });

  it('hides the "+ Task" action for read-only members', () => {
    renderSchedule({ tasks: [makeTask()], readOnly: true });
    expect(screen.queryByRole('button', { name: /^Task$/ })).not.toBeInTheDocument();
  });
});
