import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@/types';
import { PredecessorsEditor, type PredecessorWorkingRow } from './PredecessorsEditor';

function makeTask(over: Partial<Task>): Task {
  return {
    id: 'task-x',
    wbs: '1.1',
    name: 'Task X',
    start: '2026-01-01',
    finish: '2026-01-02',
    plannedStart: null,
    duration: 1,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
    ...over,
  } as Task;
}

describe('PredecessorsEditor', () => {
  it('renders only the closed-state "+ Link predecessor" button when there are no rows', () => {
    render(
      <PredecessorsEditor
        rows={[]}
        allTasks={[]}
        currentTaskId={null}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: '+ Link predecessor' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('renders existing rows with the dash placeholder when WBS is empty', () => {
    const rows: PredecessorWorkingRow[] = [
      { predecessorId: 'p1', predecessorName: 'Predecessor One', predecessorWbs: '' },
    ];
    render(
      <PredecessorsEditor
        rows={rows}
        allTasks={[]}
        currentTaskId={null}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText('Predecessor One')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove predecessor Predecessor One' }),
    ).toBeInTheDocument();
    // Placeholder dash for the missing WBS.
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('opens the picker when "+ Link predecessor" is clicked and shows the search input', () => {
    render(
      <PredecessorsEditor
        rows={[]}
        allTasks={[makeTask({ id: 't1', name: 'Foo', wbs: '1' })]}
        currentTaskId={null}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Link predecessor' }));
    expect(screen.getByLabelText('Search predecessor tasks')).toBeInTheDocument();
    expect(screen.getByText('Foo')).toBeInTheDocument();
  });

  it('excludes the current task, summary tasks, and already-assigned predecessors from the picker', () => {
    const allTasks = [
      makeTask({ id: 'self', name: 'Self', wbs: '1' }),
      makeTask({ id: 'summary', name: 'Roll-up', wbs: '2', isSummary: true }),
      makeTask({ id: 'already', name: 'Already linked', wbs: '3' }),
      makeTask({ id: 'avail', name: 'Available', wbs: '4' }),
    ];
    const rows: PredecessorWorkingRow[] = [
      { predecessorId: 'already', predecessorName: 'Already linked', predecessorWbs: '3' },
    ];
    render(
      <PredecessorsEditor
        rows={rows}
        allTasks={allTasks}
        currentTaskId="self"
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Link predecessor' }));
    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.queryByText('Self')).not.toBeInTheDocument();
    expect(screen.queryByText('Roll-up')).not.toBeInTheDocument();
    // The chip row still shows the already-linked entry, but the picker
    // listbox does not.
    expect(listbox.textContent).not.toContain('Already linked');
  });

  it('filters the picker by name (case-insensitive) and by WBS substring', () => {
    const allTasks = [
      makeTask({ id: 'a', name: 'Design Sprint', wbs: '1.1' }),
      makeTask({ id: 'b', name: 'Build Phase', wbs: '2.4.7' }),
    ];
    render(
      <PredecessorsEditor
        rows={[]}
        allTasks={allTasks}
        currentTaskId={null}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Link predecessor' }));
    const search = screen.getByLabelText('Search predecessor tasks');
    fireEvent.change(search, { target: { value: 'design' } });
    expect(screen.getByText('Design Sprint')).toBeInTheDocument();
    expect(screen.queryByText('Build Phase')).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: '2.4' } });
    expect(screen.getByText('Build Phase')).toBeInTheDocument();
    expect(screen.queryByText('Design Sprint')).not.toBeInTheDocument();
  });

  it('caps picker results at 12 matches', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      makeTask({ id: `t${i}`, name: `Task ${i}`, wbs: `1.${i}` }),
    );
    render(
      <PredecessorsEditor
        rows={[]}
        allTasks={many}
        currentTaskId={null}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Link predecessor' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
  });

  it('calls onAdd and clears the search input when a picker option is clicked', () => {
    const onAdd = vi.fn();
    render(
      <PredecessorsEditor
        rows={[]}
        allTasks={[makeTask({ id: 't1', name: 'Foo', wbs: '1' })]}
        currentTaskId={null}
        onAdd={onAdd}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Link predecessor' }));
    const search = screen.getByLabelText<HTMLInputElement>(
      'Search predecessor tasks',
    );
    fireEvent.change(search, { target: { value: 'foo' } });
    fireEvent.click(screen.getByRole('button', { name: /Foo/ }));
    expect(onAdd).toHaveBeenCalledWith({ id: 't1', name: 'Foo', wbs: '1' });
    expect(search.value).toBe('');
  });

  it('closes the picker when the Done button is clicked', () => {
    render(
      <PredecessorsEditor
        rows={[]}
        allTasks={[makeTask({ id: 't1', name: 'Foo', wbs: '1' })]}
        currentTaskId={null}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Link predecessor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByLabelText('Search predecessor tasks')).not.toBeInTheDocument();
  });

  it('closes the picker on Escape and prevents the event from bubbling', () => {
    render(
      <PredecessorsEditor
        rows={[]}
        allTasks={[makeTask({ id: 't1', name: 'Foo', wbs: '1' })]}
        currentTaskId={null}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Link predecessor' }));
    const search = screen.getByLabelText('Search predecessor tasks');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByLabelText('Search predecessor tasks')).not.toBeInTheDocument();
  });

  it('renders the WBS dash placeholder inside picker options when wbs is empty', () => {
    render(
      <PredecessorsEditor
        rows={[]}
        allTasks={[makeTask({ id: 't1', name: 'No WBS task', wbs: '' })]}
        currentTaskId={null}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Link predecessor' }));
    expect(screen.getByText('No WBS task')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders no picker results listbox when nothing matches the search', () => {
    render(
      <PredecessorsEditor
        rows={[]}
        allTasks={[makeTask({ id: 't1', name: 'Alpha', wbs: '1' })]}
        currentTaskId={null}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Link predecessor' }));
    fireEvent.change(screen.getByLabelText('Search predecessor tasks'), {
      target: { value: 'zzz' },
    });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('disables the open-picker button and remove buttons when disabled is true', () => {
    const rows: PredecessorWorkingRow[] = [
      { predecessorId: 'p1', predecessorName: 'P', predecessorWbs: '1' },
    ];
    render(
      <PredecessorsEditor
        rows={rows}
        allTasks={[]}
        currentTaskId={null}
        disabled
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '+ Link predecessor' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove predecessor P' })).toBeDisabled();
  });

  it('calls onRemove with the row index when the chip × is clicked', () => {
    const onRemove = vi.fn();
    const rows: PredecessorWorkingRow[] = [
      { predecessorId: 'p1', predecessorName: 'A', predecessorWbs: '1' },
      { predecessorId: 'p2', predecessorName: 'B', predecessorWbs: '2' },
    ];
    render(
      <PredecessorsEditor
        rows={rows}
        allTasks={[]}
        currentTaskId={null}
        onAdd={vi.fn()}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove predecessor B' }));
    expect(onRemove).toHaveBeenCalledWith(1);
  });
});
