import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { OutlineRow } from './OutlineRow';
import type { WbsNode } from './buildWbsTree';
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
    notes: '',
    ...overrides,
  };
}

function makeNode(overrides: Partial<Task> & Pick<Task, 'id' | 'wbs'>, depth = 0, children: WbsNode[] = []): WbsNode {
  return {
    task: makeTask(overrides),
    depth,
    parentWbs: '',
    children,
  };
}

const baseProps = {
  isExpanded: false,
  isRenaming: false,
  isSelected: false,
  predecessorText: '',
  onToggle: vi.fn(),
  onSelect: vi.fn(),
  onStartRename: vi.fn(),
  onRename: vi.fn(),
  onCancelRename: vi.fn(),
};

function renderRow(node: WbsNode, props: Partial<typeof baseProps> = {}) {
  return render(
    <DndContext>
      <SortableContext items={[node.task.id]} strategy={verticalListSortingStrategy}>
        <OutlineRow {...baseProps} node={node} {...props} />
      </SortableContext>
    </DndContext>,
  );
}

describe('OutlineRow', () => {
  it('renders the WBS code, name, and predecessor text', () => {
    const node = makeNode({ id: 't1', wbs: '1.1', name: 'Discovery' });
    renderRow(node, { predecessorText: '1.0 FS+2' });
    expect(screen.getByText('1.1')).toBeInTheDocument();
    expect(screen.getByText('Discovery')).toBeInTheDocument();
    expect(screen.getByText('1.0 FS+2')).toBeInTheDocument();
  });

  it('shows the expand button when the node has children', () => {
    const child = makeNode({ id: 'c', wbs: '1.1' }, 1);
    const parent = makeNode({ id: 'p', wbs: '1', isSummary: true }, 0, [child]);
    renderRow(parent);
    expect(screen.getByRole('button', { name: /expand p/i })).toBeInTheDocument();
  });

  it('shows the collapse label when expanded', () => {
    const child = makeNode({ id: 'c', wbs: '1.1' }, 1);
    const parent = makeNode({ id: 'p', wbs: '1', isSummary: true }, 0, [child]);
    renderRow(parent, { isExpanded: true });
    expect(screen.getByRole('button', { name: /collapse p/i })).toBeInTheDocument();
  });

  it('clicking the expand button calls onToggle and stops propagation to onSelect', () => {
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const child = makeNode({ id: 'c', wbs: '1.1' }, 1);
    const parent = makeNode({ id: 'p', wbs: '1', isSummary: true }, 0, [child]);
    renderRow(parent, { onToggle, onSelect });
    fireEvent.click(screen.getByRole('button', { name: /expand p/i }));
    expect(onToggle).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders the milestone diamond glyph for milestone leaves', () => {
    const node = makeNode({ id: 't1', wbs: '1.1', isMilestone: true });
    renderRow(node);
    expect(screen.getByText('◆')).toBeInTheDocument();
  });

  it('renders the box glyph for non-milestone leaves', () => {
    const node = makeNode({ id: 't1', wbs: '1.1' });
    renderRow(node);
    expect(screen.getByText('□')).toBeInTheDocument();
  });

  it('renders the CP badge for critical tasks', () => {
    const node = makeNode({ id: 't1', wbs: '1.1', isCritical: true });
    renderRow(node);
    expect(screen.getByLabelText('Critical path')).toBeInTheDocument();
  });

  it('clicking the row invokes onSelect', () => {
    const onSelect = vi.fn();
    const node = makeNode({ id: 't1', wbs: '1.1' });
    renderRow(node, { onSelect });
    fireEvent.click(screen.getByRole('row'));
    expect(onSelect).toHaveBeenCalled();
  });

  it('double-click on a leaf triggers onStartRename', () => {
    const onStartRename = vi.fn();
    const node = makeNode({ id: 't1', wbs: '1.1' });
    renderRow(node, { onStartRename });
    fireEvent.doubleClick(screen.getByRole('row'));
    expect(onStartRename).toHaveBeenCalled();
  });

  it('double-click on a summary does NOT trigger onStartRename', () => {
    const onStartRename = vi.fn();
    const node = makeNode({ id: 'p1', wbs: '1', isSummary: true });
    renderRow(node, { onStartRename });
    fireEvent.doubleClick(screen.getByRole('row'));
    expect(onStartRename).not.toHaveBeenCalled();
  });

  it('F2 on the row triggers onStartRename', () => {
    const onStartRename = vi.fn();
    const node = makeNode({ id: 't1', wbs: '1.1' });
    renderRow(node, { onStartRename });
    fireEvent.keyDown(screen.getByRole('row'), { key: 'F2' });
    expect(onStartRename).toHaveBeenCalled();
  });

  it('Enter inside the rename input commits the new name', () => {
    const onRename = vi.fn();
    const node = makeNode({ id: 't1', wbs: '1.1' });
    renderRow(node, { isRenaming: true, onRename });
    const input = screen.getByLabelText('Rename task');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('Renamed');
  });

  it('Escape inside the rename input invokes onCancelRename', () => {
    const onCancelRename = vi.fn();
    const node = makeNode({ id: 't1', wbs: '1.1' });
    renderRow(node, { isRenaming: true, onCancelRename });
    fireEvent.keyDown(screen.getByLabelText('Rename task'), { key: 'Escape' });
    expect(onCancelRename).toHaveBeenCalled();
  });

  it('shows the owner avatar with initials when an assignee is present', () => {
    const node = makeNode({
      id: 't1', wbs: '1.1',
      assignees: [{ resourceId: 'r1', name: 'Alice Smith', units: 100 }],
    });
    renderRow(node);
    expect(screen.getByLabelText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('AS')).toBeInTheDocument();
  });

  it('renders project rows (root summary) at the larger height', () => {
    const node = makeNode({ id: 'p', wbs: '1', isSummary: true });
    const { container } = renderRow(node);
    expect(container.querySelector('.h-11')).not.toBeNull();
  });
});
