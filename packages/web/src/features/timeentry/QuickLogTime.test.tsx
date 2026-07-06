import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { MyWorkTask } from '@/hooks/useMyWork';
import { QuickLogTime } from './QuickLogTime';

const useMyWorkMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useMyWork', () => ({ useMyWork: useMyWorkMock }));

const mutateMock = vi.hoisted(() => vi.fn());
const useCreateTimeEntryMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useCreateTimeEntry', () => ({ useCreateTimeEntry: useCreateTimeEntryMock }));

function makeTask(partial: Partial<MyWorkTask> & Pick<MyWorkTask, 'id' | 'short_id' | 'name'>): MyWorkTask {
  return {
    project_id: 'p1',
    project_name: 'Riverside',
    program_id: null,
    program_name: null,
    program_color: null,
    sprint_id: null,
    sprint_name: null,
    status: 'IN_PROGRESS',
    story_points: null,
    remaining_points: null,
    due: null,
    due_source: null,
    is_critical: false,
    group: 'today',
    is_blocked: false,
    blocked_reason: '',
    blocker_type: '',
    blocked_age_seconds: null,
    server_version: 1,
    url: '',
    ...partial,
  } as MyWorkTask;
}

const TASKS = [
  makeTask({ id: 'task-a', short_id: 'RIV-1', name: 'Foundation pour', project_name: 'Riverside' }),
  makeTask({ id: 'task-b', short_id: 'RIV-2', name: 'Framing', project_name: 'Riverside' }),
];

function setTasks(tasks: MyWorkTask[]) {
  useMyWorkMock.mockReturnValue({ data: { pages: [{ results: tasks }] } });
}

function openPopover() {
  render(<QuickLogTime />);
  fireEvent.click(screen.getByRole('button', { name: 'Log time' }));
  return screen.getByRole('dialog', { name: 'Log time' });
}

describe('QuickLogTime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTasks(TASKS);
    useCreateTimeEntryMock.mockReturnValue({ mutate: mutateMock, isPending: false });
  });

  it('opens and closes the popover from the top-bar trigger', () => {
    render(<QuickLogTime />);
    const trigger = screen.getByRole('button', { name: 'Log time' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Log time' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape (focus trap)', () => {
    const dialog = openPopover();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('defaults the selection to the first assigned task and defaults to 1h', () => {
    openPopover();
    const first = screen.getByRole('radio', { name: /RIV-1 Foundation pour/ });
    expect(first).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'Log 1h 00m' })).toBeInTheDocument();
  });

  it('filters the task list by the search query', () => {
    openPopover();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search your tasks' }), {
      target: { value: 'fram' },
    });
    expect(screen.queryByRole('radio', { name: /Foundation pour/ })).toBeNull();
    expect(screen.getByRole('radio', { name: /Framing/ })).toBeInTheDocument();
  });

  it('a preset chip updates the minutes and Log label', () => {
    openPopover();
    fireEvent.click(screen.getByRole('button', { name: '30m', pressed: false }));
    expect(screen.getByRole('button', { name: '30m' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Log 30m' })).toBeInTheDocument();
  });

  it('a manual duration overrides the preset selection', () => {
    openPopover();
    fireEvent.change(screen.getByRole('textbox', { name: /Custom duration/ }), {
      target: { value: '1:45' },
    });
    expect(screen.getByRole('button', { name: 'Log 1h 45m' })).toBeInTheDocument();
    // No preset shows pressed once a valid manual value is entered.
    expect(screen.getByRole('button', { name: '1h' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('flags an invalid manual duration and disables logging (no stale value)', () => {
    openPopover();
    fireEvent.change(screen.getByRole('textbox', { name: /Custom duration/ }), {
      target: { value: 'abc' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/1:30/);
    // The primary action must not log the previous (stale) 1h while the field is invalid.
    expect(screen.getByRole('button', { name: /^Log \d/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^Log \d/ }));
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('moves the task selection with Arrow keys (radio keyboard pattern)', () => {
    openPopover();
    const group = screen.getByRole('radiogroup', { name: 'Select a task' });
    expect(screen.getByRole('radio', { name: /RIV-1 Foundation pour/ })).toBeChecked();

    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(screen.getByRole('radio', { name: /RIV-2 Framing/ })).toBeChecked();

    // Wraps around back to the first item.
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(screen.getByRole('radio', { name: /RIV-1 Foundation pour/ })).toBeChecked();
  });

  it('logs the selected task + duration and closes', () => {
    openPopover();
    // Pick the second task and a 2h preset.
    fireEvent.click(screen.getByRole('radio', { name: /RIV-2 Framing/ }));
    fireEvent.click(screen.getByRole('button', { name: '2h' }));
    fireEvent.click(screen.getByRole('button', { name: 'Log 2h 00m' }));

    expect(mutateMock).toHaveBeenCalledWith({
      taskId: 'task-b',
      taskLabel: 'RIV-2 · Framing',
      minutes: 120,
      entryDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as unknown as string,
      note: undefined,
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('includes a trimmed note when provided', () => {
    openPopover();
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), {
      target: { value: '  poured slab  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Log \d/ }));
    expect(mutateMock).toHaveBeenCalledWith(expect.objectContaining({ note: 'poured slab' }));
  });

  it('shows an empty state and disables logging with no assigned tasks', () => {
    setTasks([]);
    openPopover();
    expect(screen.getByText(/No assigned tasks to log against/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Log \d/ })).toBeDisabled();
  });
});
