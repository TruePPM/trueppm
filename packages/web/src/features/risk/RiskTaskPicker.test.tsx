/**
 * Behaviour tests for <RiskTaskPicker> — the inline task picker in the risk
 * create/edit form (#2156, ADR-0566).
 *
 * Covers the branches the form-level specs never reach: the loading / error /
 * at-limit states, the candidate filter (leaf work only, already-linked
 * excluded, name / WBS / short-id matching, MAX_RESULTS cap), the chip list and
 * its "Unavailable task" fallback, the full keyboard contract (ArrowDown /
 * ArrowUp clamping, Enter, Escape scoping, Backspace-to-unlink), the
 * mouse-down pick, and the delayed blur close.
 */
import { fireEvent, screen, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { RiskTaskPicker } from './RiskTaskPicker';
import type { Task } from '@/types';
import type { UseScheduleTasksResult } from '@/hooks/useScheduleTasks';

const useScheduleTasksMock = vi.hoisted(() =>
  vi.fn<(projectId?: string) => UseScheduleTasksResult>(),
);

vi.mock('@/hooks/useScheduleTasks', () => ({ useScheduleTasks: useScheduleTasksMock }));

function makeTask(id: string, name: string, over: Partial<Task> = {}): Task {
  const base: Task = {
    id,
    wbs: '',
    name,
    start: '2026-01-01',
    finish: '2026-01-02',
    duration: 1,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'IN_PROGRESS',
    assignees: [],
    notes: '',
  };
  return { ...base, ...over };
}

/** Drive the hook to a loaded state with the given task list. */
function loaded(tasks: Task[]): UseScheduleTasksResult {
  return { tasks, links: [], isLoading: false, error: null };
}

const TASKS: Task[] = [
  makeTask('t1', 'Pour foundation', { wbs: '1.1', shortId: 'T-101' }),
  makeTask('t2', 'Frame walls', { wbs: '1.2', shortId: 'T-102', status: 'NOT_STARTED' }),
  makeTask('t3', 'Run electrical', { wbs: '1.3', shortId: 'T-103', status: 'COMPLETE' }),
  makeTask('s1', 'Construction phase', { wbs: '1', isSummary: true, shortId: 'T-100' }),
  makeTask('m1', 'Permit approved', { wbs: '1.4', isMilestone: true, shortId: 'T-104' }),
];

function combobox(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('combobox', { name: 'Search tasks to link' });
}

function optionLabels(): string[] {
  return screen.getAllByRole('option').map((li) => li.textContent ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  useScheduleTasksMock.mockReturnValue(loaded(TASKS));
});

// ---------------------------------------------------------------------------
// Loading / error / limit states
// ---------------------------------------------------------------------------

describe('RiskTaskPicker states', () => {
  it('disables the input and shows a loading placeholder while tasks load', () => {
    useScheduleTasksMock.mockReturnValue({
      tasks: undefined,
      links: undefined,
      isLoading: true,
      error: null,
    });
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
    );

    const input = combobox();
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('Loading tasks…');

    // isLoading suppresses the list even once focused.
    fireEvent.focus(input);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('falls back to "Unavailable task" chips while the task list is still undefined', () => {
    useScheduleTasksMock.mockReturnValue({
      tasks: undefined,
      links: undefined,
      isLoading: true,
      error: null,
    });
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={['t1']} onChange={vi.fn()} />,
    );

    expect(screen.getByRole('list', { name: 'Linked tasks' })).toHaveTextContent(
      'Unavailable task',
    );
  });

  it('surfaces a non-blocking alert when the task fetch fails', () => {
    useScheduleTasksMock.mockReturnValue({
      tasks: undefined,
      links: undefined,
      isLoading: false,
      error: new Error('boom'),
    });
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      "Couldn't load tasks to link. You can still save other changes.",
    );
  });

  it('renders no alert on the happy path and advertises the link budget', () => {
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} max={4} />,
    );

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Attach up to 4 tasks from this project.')).toBeInTheDocument();
    expect(combobox().placeholder).toBe('Search tasks to link…');
  });

  it('locks the input and swaps the help text once the link limit is reached', () => {
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={['t1', 't2']} onChange={vi.fn()} max={2} />,
    );

    const input = combobox();
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('Maximum of 2 tasks linked.');
    expect(
      screen.getByText('Limit reached — remove a task to link another.'),
    ).toBeInTheDocument();

    fireEvent.focus(input);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('refuses to link another task from the keyboard once at the limit', () => {
    const onChange = vi.fn<(ids: string[]) => void>();
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={['t1', 't2']} onChange={onChange} max={2} />,
    );

    const input = combobox();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Selected chips
// ---------------------------------------------------------------------------

describe('RiskTaskPicker selected chips', () => {
  it('renders no chip list when nothing is linked yet', () => {
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
    );
    expect(screen.queryByRole('list', { name: 'Linked tasks' })).toBeNull();
  });

  it('names known tasks and degrades an unknown id to "Unavailable task"', () => {
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={['t1', 'ghost']} onChange={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: 'Remove Pour foundation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Unavailable task' })).toBeInTheDocument();
  });

  it('emits the remaining id set when a chip is dismissed', () => {
    const onChange = vi.fn<(ids: string[]) => void>();
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={['t1', 't2']} onChange={onChange} max={5} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove Pour foundation' }));
    expect(onChange).toHaveBeenCalledWith(['t2']);
  });
});

// ---------------------------------------------------------------------------
// Candidate filtering
// ---------------------------------------------------------------------------

describe('RiskTaskPicker candidate filtering', () => {
  it('offers leaf work only — summaries and milestones are never linkable', () => {
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
    );
    fireEvent.focus(combobox());

    const labels = optionLabels();
    expect(labels).toHaveLength(3);
    expect(labels.join('|')).not.toContain('Construction phase');
    expect(labels.join('|')).not.toContain('Permit approved');
  });

  it('hides tasks that are already linked', () => {
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={['t1']} onChange={vi.fn()} max={5} />,
    );
    fireEvent.focus(combobox());

    expect(optionLabels().join('|')).not.toContain('Pour foundation');
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('matches on task name', () => {
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
    );
    fireEvent.change(combobox(), { target: { value: 'frame' } });

    expect(optionLabels()).toHaveLength(1);
    expect(optionLabels()[0]).toContain('Frame walls');
  });

  it('matches on WBS code', () => {
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
    );
    fireEvent.change(combobox(), { target: { value: '1.3' } });

    expect(optionLabels()).toHaveLength(1);
    expect(optionLabels()[0]).toContain('Run electrical');
  });

  it('matches on short id', () => {
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
    );
    fireEvent.change(combobox(), { target: { value: 't-101' } });

    expect(optionLabels()).toHaveLength(1);
    expect(optionLabels()[0]).toContain('Pour foundation');
  });

  it('shows the empty state when nothing matches the query', () => {
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
    );
    fireEvent.change(combobox(), { target: { value: 'zzzz' } });

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No matching tasks. Try a different search.')).toBeInTheDocument();
    // With no results there is no active option to point at.
    expect(combobox()).not.toHaveAttribute('aria-activedescendant');
  });

  it('searches safely against tasks that carry neither a WBS code nor a short id', () => {
    useScheduleTasksMock.mockReturnValue(
      loaded([makeTask('bare', 'Untracked work'), makeTask('t1', 'Pour foundation')]),
    );
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
    );

    // No name / WBS / short-id match anywhere — the missing identifiers must not
    // throw, they just fail to match.
    fireEvent.change(combobox(), { target: { value: 'zz' } });
    expect(screen.getByText('No matching tasks. Try a different search.')).toBeInTheDocument();

    fireEvent.change(combobox(), { target: { value: 'untracked' } });
    expect(optionLabels()).toHaveLength(1);
    expect(optionLabels()[0]).toContain('Untracked work');
  });

  it('caps the result list at 12 even when far more tasks match', () => {
    const many = Array.from({ length: 20 }, (_, i) => makeTask(`x${i}`, `Task ${i}`));
    useScheduleTasksMock.mockReturnValue(loaded(many));
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
    );
    fireEvent.focus(combobox());

    expect(screen.getAllByRole('option')).toHaveLength(12);
  });

  it('prefers the short id, falls back to the WBS code, then to an em dash', () => {
    useScheduleTasksMock.mockReturnValue(
      loaded([
        makeTask('a', 'Has short id', { shortId: 'T-9', wbs: '2.1' }),
        makeTask('b', 'Wbs only', { wbs: '2.2' }),
        makeTask('c', 'Neither'),
      ]),
    );
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
    );
    fireEvent.focus(combobox());

    const labels = optionLabels();
    expect(labels[0]).toContain('T-9');
    expect(labels[1]).toContain('2.2');
    expect(labels[2]).toContain('—');
  });

  it('humanizes each candidate status', () => {
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
    );
    fireEvent.focus(combobox());

    const labels = optionLabels();
    expect(labels[0]).toContain('In progress');
    expect(labels[1]).toContain('Not started');
    expect(labels[2]).toContain('Complete');
  });
});

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

describe('RiskTaskPicker picking', () => {
  it('links a task on mouse-down and clears the query', () => {
    const onChange = vi.fn<(ids: string[]) => void>();
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={['t3']} onChange={onChange} max={5} />,
    );

    const input = combobox();
    fireEvent.change(input, { target: { value: 'frame' } });
    fireEvent.mouseDown(screen.getByRole('button', { name: /Frame walls/ }));

    expect(onChange).toHaveBeenCalledWith(['t3', 't2']);
    expect(combobox().value).toBe('');
  });

  it('tracks the hovered row as the active option', () => {
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
    );
    fireEvent.focus(combobox());

    fireEvent.mouseEnter(screen.getByRole('button', { name: /Run electrical/ }));

    const options = screen.getAllByRole('option');
    expect(options[2]).toHaveAttribute('aria-selected', 'true');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    expect(combobox()).toHaveAttribute('aria-activedescendant', 'risk-task-opt-2');
  });
});

// ---------------------------------------------------------------------------
// Keyboard contract
// ---------------------------------------------------------------------------

describe('RiskTaskPicker keyboard', () => {
  it('ArrowDown opens the list and advances the active option, clamping at the end', () => {
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
    );
    const input = combobox();
    expect(input).toHaveAttribute('aria-expanded', 'false');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(combobox()).toHaveAttribute('aria-expanded', 'true');
    expect(combobox()).toHaveAttribute('aria-activedescendant', 'risk-task-opt-1');

    fireEvent.keyDown(combobox(), { key: 'ArrowDown' });
    fireEvent.keyDown(combobox(), { key: 'ArrowDown' });
    // Only three candidates — the cursor stops on the last one.
    expect(combobox()).toHaveAttribute('aria-activedescendant', 'risk-task-opt-2');
  });

  it('ArrowUp walks back and clamps at the first option', () => {
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
    );
    const input = combobox();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(combobox(), { key: 'ArrowUp' });
    expect(combobox()).toHaveAttribute('aria-activedescendant', 'risk-task-opt-0');

    fireEvent.keyDown(combobox(), { key: 'ArrowUp' });
    expect(combobox()).toHaveAttribute('aria-activedescendant', 'risk-task-opt-0');
  });

  it('Enter links the active option', () => {
    const onChange = vi.fn<(ids: string[]) => void>();
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={onChange} max={5} />,
    );
    const input = combobox();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(combobox(), { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith(['t2']);
  });

  it('Enter is inert when the query matches nothing', () => {
    const onChange = vi.fn<(ids: string[]) => void>();
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={onChange} />,
    );
    fireEvent.change(combobox(), { target: { value: 'nothing here' } });
    fireEvent.keyDown(combobox(), { key: 'Enter' });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('Escape closes only the results list and never reaches the drawer-level handler', () => {
    // The risk drawer listens for Escape on the document; a picker Escape that
    // closes the list must not also close the whole drawer.
    const drawerEscape = vi.fn();
    document.addEventListener('keydown', drawerEscape);
    try {
      renderWithProviders(
        <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
      );
      fireEvent.focus(combobox());
      expect(screen.getByRole('listbox')).toBeInTheDocument();

      fireEvent.keyDown(combobox(), { key: 'Escape' });

      expect(screen.queryByRole('listbox')).toBeNull();
      expect(drawerEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', drawerEscape);
    }
  });

  it('lets Escape through to the drawer when the list is already closed', () => {
    const drawerEscape = vi.fn();
    document.addEventListener('keydown', drawerEscape);
    try {
      renderWithProviders(
        <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
      );

      fireEvent.keyDown(combobox(), { key: 'Escape' });
      expect(drawerEscape).toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', drawerEscape);
    }
  });

  it('Backspace on an empty query unlinks the most recent chip', () => {
    const onChange = vi.fn<(ids: string[]) => void>();
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={['t1', 't2']} onChange={onChange} max={5} />,
    );

    fireEvent.keyDown(combobox(), { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledWith(['t1']);
  });

  it('Backspace deletes text instead of unlinking while the query is non-empty', () => {
    const onChange = vi.fn<(ids: string[]) => void>();
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={['t1']} onChange={onChange} max={5} />,
    );

    fireEvent.change(combobox(), { target: { value: 'fr' } });
    fireEvent.keyDown(combobox(), { key: 'Backspace' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Backspace is inert when nothing is linked', () => {
    const onChange = vi.fn<(ids: string[]) => void>();
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={onChange} />,
    );

    fireEvent.keyDown(combobox(), { key: 'Backspace' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores unrelated keys', () => {
    const onChange = vi.fn<(ids: string[]) => void>();
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={['t1']} onChange={onChange} max={5} />,
    );

    fireEvent.keyDown(combobox(), { key: 'a' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Blur close + active-index clamping
// ---------------------------------------------------------------------------

describe('RiskTaskPicker list lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the list up briefly after blur so a mouse-down pick still registers', () => {
    renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
    );
    const input = combobox();
    fireEvent.focus(input);
    fireEvent.blur(input);

    // Still open inside the 120 ms grace window.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not close the list after unmount when a blur is still pending', () => {
    const spy = vi.spyOn(console, 'error');
    const { unmount } = renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
    );
    const input = combobox();
    fireEvent.focus(input);
    fireEvent.blur(input);
    unmount();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    // The cleanup cleared the timer — no state update on an unmounted tree.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('unmounts cleanly when no blur timer was ever scheduled', () => {
    const spy = vi.spyOn(console, 'error');
    const { unmount } = renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} />,
    );
    unmount();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('pulls the active option back in range when the candidate list shrinks', () => {
    const { rerender } = renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} max={5} />,
    );
    fireEvent.keyDown(combobox(), { key: 'ArrowDown' });
    fireEvent.keyDown(combobox(), { key: 'ArrowDown' });
    expect(combobox()).toHaveAttribute('aria-activedescendant', 'risk-task-opt-2');

    // Linking two of the three candidates leaves a single option behind.
    rerender(
      <RiskTaskPicker projectId="p1" selectedIds={['t2', 't3']} onChange={vi.fn()} max={5} />,
    );

    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(combobox()).toHaveAttribute('aria-activedescendant', 'risk-task-opt-0');
  });

  it('resets the active index to zero when every candidate is linked', () => {
    const { rerender } = renderWithProviders(
      <RiskTaskPicker projectId="p1" selectedIds={[]} onChange={vi.fn()} max={5} />,
    );
    fireEvent.keyDown(combobox(), { key: 'ArrowDown' });

    rerender(
      <RiskTaskPicker
        projectId="p1"
        selectedIds={['t1', 't2', 't3']}
        onChange={vi.fn()}
        max={5}
      />,
    );

    expect(screen.getByText('No matching tasks. Try a different search.')).toBeInTheDocument();
    expect(combobox()).not.toHaveAttribute('aria-activedescendant');
  });
});
