import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TaskRow } from './TaskRow';
import type { Task } from '@/types';

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'wbs'>): Task {
  return {
    name: overrides.id,
    start: '2026-05-01',
    finish: '2026-05-05',
    duration: 4,
    progress: 25,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'IN_PROGRESS',
    assignees: [],
    ...overrides,
  };
}

const baseProps = {
  rowIndex: 0,
  isSelected: false,
  isRenaming: false,
  onToggleSelect: vi.fn(),
  onStartRename: vi.fn(),
  onRename: vi.fn(),
  onCancelRename: vi.fn(),
};

describe('TaskRow', () => {
  it('renders the task name and the phase subtitle when phase is set', () => {
    const task = makeTask({ id: 't1', wbs: '1.1', name: 'Build' });
    render(<TaskRow {...baseProps} task={task} phase="Discovery" />);
    expect(screen.getByText('Build')).toBeInTheDocument();
    expect(screen.getByText('· Discovery')).toBeInTheDocument();
  });

  it('omits the phase subtitle when phase is the dash placeholder', () => {
    const task = makeTask({ id: 't1', wbs: '1' });
    render(<TaskRow {...baseProps} task={task} phase="—" />);
    expect(screen.queryByText('· —')).not.toBeInTheDocument();
  });

  it('shows the CP badge for critical tasks', () => {
    const task = makeTask({ id: 't1', wbs: '1.1', isCritical: true });
    render(<TaskRow {...baseProps} task={task} phase="Discovery" />);
    expect(screen.getByLabelText('Critical path')).toBeInTheDocument();
  });

  it('does not show the CP badge for non-critical tasks', () => {
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(<TaskRow {...baseProps} task={task} phase="Discovery" />);
    expect(screen.queryByLabelText('Critical path')).not.toBeInTheDocument();
  });

  it('renders the owner avatar when an assignee is present', () => {
    const task = makeTask({
      id: 't1', wbs: '1.1',
      assignees: [{ resourceId: 'r1', name: 'Alice Smith', units: 100 }],
    });
    render(<TaskRow {...baseProps} task={task} phase="Discovery" />);
    expect(screen.getByLabelText('Alice Smith')).toBeInTheDocument();
  });

  it('omits the avatar when there is no assignee', () => {
    const task = makeTask({ id: 't1', wbs: '1.1' });
    const { container } = render(<TaskRow {...baseProps} task={task} phase="Discovery" />);
    expect(container.querySelector('[aria-label="Alice"]')).toBeNull();
  });

  it('F2 invokes onStartRename', () => {
    const onStartRename = vi.fn();
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(<TaskRow {...baseProps} task={task} phase="—" onStartRename={onStartRename} />);
    const row = screen.getByRole('row');
    fireEvent.keyDown(row, { key: 'F2' });
    expect(onStartRename).toHaveBeenCalled();
  });

  it('double-click on a leaf invokes onStartRename', () => {
    const onStartRename = vi.fn();
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(<TaskRow {...baseProps} task={task} phase="—" onStartRename={onStartRename} />);
    fireEvent.doubleClick(screen.getByRole('row'));
    expect(onStartRename).toHaveBeenCalled();
  });

  it('double-click on a summary does NOT invoke onStartRename', () => {
    const onStartRename = vi.fn();
    const task = makeTask({ id: 'p1', wbs: '1', isSummary: true });
    render(<TaskRow {...baseProps} task={task} phase="—" onStartRename={onStartRename} />);
    fireEvent.doubleClick(screen.getByRole('row'));
    expect(onStartRename).not.toHaveBeenCalled();
  });

  it('Enter inside the rename input commits the new name', () => {
    const onRename = vi.fn();
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(<TaskRow {...baseProps} task={task} phase="—" isRenaming onRename={onRename} />);
    const input = screen.getByLabelText('Rename task');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('Renamed');
  });

  it('Escape inside the rename input invokes onCancelRename', () => {
    const onCancelRename = vi.fn();
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(<TaskRow {...baseProps} task={task} phase="—" isRenaming onCancelRename={onCancelRename} />);
    fireEvent.keyDown(screen.getByLabelText('Rename task'), { key: 'Escape' });
    expect(onCancelRename).toHaveBeenCalled();
  });

  it('checkbox toggle invokes onToggleSelect', () => {
    const onToggleSelect = vi.fn();
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(<TaskRow {...baseProps} task={task} phase="—" onToggleSelect={onToggleSelect} />);
    fireEvent.click(screen.getByLabelText(`Select ${task.name}`));
    expect(onToggleSelect).toHaveBeenCalled();
  });

  it('renders a selected row with brand-primary styling and aria-selected', () => {
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(<TaskRow {...baseProps} task={task} phase="—" isSelected />);
    expect(screen.getByRole('row')).toHaveAttribute('aria-selected', 'true');
  });

  it('alternates row background for odd rowIndex', () => {
    const task = makeTask({ id: 't1', wbs: '1.1' });
    const { container } = render(<TaskRow {...baseProps} task={task} phase="—" rowIndex={1} />);
    expect(container.querySelector('.bg-neutral-surface-raised')).not.toBeNull();
  });

  it('blur with relatedTarget OUTSIDE the row commits the rename', () => {
    const onRename = vi.fn();
    const task = makeTask({ id: 't1', wbs: '1.1' });
    const { unmount } = render(
      <>
        <TaskRow {...baseProps} task={task} phase="—" isRenaming onRename={onRename} />
        <button type="button" data-testid="outside">elsewhere</button>
      </>,
    );
    const input = screen.getByLabelText('Rename task');
    const outside = screen.getByTestId('outside');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.blur(input, { relatedTarget: outside });
    expect(onRename).toHaveBeenCalledWith('Renamed');
    unmount();
  });

  it('blur with relatedTarget INSIDE the same row does NOT commit', () => {
    const onRename = vi.fn();
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(
      <TaskRow {...baseProps} task={task} phase="—" isRenaming onRename={onRename} />,
    );
    const input = screen.getByLabelText('Rename task');
    const checkbox = screen.getByLabelText(`Select ${task.name}`);
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.blur(input, { relatedTarget: checkbox });
    expect(onRename).not.toHaveBeenCalled();
  });

  it('keys other than Enter/Escape inside the rename input are ignored', () => {
    const onRename = vi.fn();
    const onCancelRename = vi.fn();
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(
      <TaskRow
        {...baseProps}
        task={task}
        phase="—"
        isRenaming
        onRename={onRename}
        onCancelRename={onCancelRename}
      />,
    );
    fireEvent.keyDown(screen.getByLabelText('Rename task'), { key: 'a' });
    expect(onRename).not.toHaveBeenCalled();
    expect(onCancelRename).not.toHaveBeenCalled();
  });
});
