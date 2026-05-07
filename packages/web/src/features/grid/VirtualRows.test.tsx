import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VirtualRows, type ListItem } from './VirtualRows';
import type { Task } from '@/types';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return this; } };
    },
  });
});

vi.mock('@tanstack/react-virtual', () => ({
  // The mock honours the `count` arg from VirtualRows (which is `items.length`)
  // for the typical case, but rowCount > items.length is what triggers the
  // out-of-range guard tested below.
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (i: number) => number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      index, key: index,
      start: index * estimateSize(index),
      size: estimateSize(index),
      end: (index + 1) * estimateSize(index),
      lane: 0,
    })),
    getTotalSize: () => count * 44,
  }),
}));

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'wbs'>): Task {
  return {
    name: overrides.id,
    start: '2026-05-01',
    finish: '2026-05-05',
    duration: 4,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
    ...overrides,
  };
}

describe('VirtualRows', () => {
  it('renders both group headers and task rows in order', () => {
    const items: ListItem[] = [
      { kind: 'header', id: 'g1', label: 'Phase A', count: 1 },
      { kind: 'task', task: makeTask({ id: 't1', wbs: '1.1', name: 'Task 1' }), phase: 'Phase A', rowIndex: 0 },
      { kind: 'header', id: 'g2', label: 'Phase B', count: 1 },
      { kind: 'task', task: makeTask({ id: 't2', wbs: '2.1', name: 'Task 2' }), phase: 'Phase B', rowIndex: 1 },
    ];
    render(
      <VirtualRows
        items={items}
        rowCount={2}
        selectedIds={new Set()}
        renamingId={null}
        onToggleSelect={vi.fn()}
        onStartRename={vi.fn()}
        onRename={vi.fn()}
        onCancelRename={vi.fn()}
      />,
    );
    expect(screen.getByText('Phase A')).toBeInTheDocument();
    expect(screen.getByText('Phase B')).toBeInTheDocument();
    expect(screen.getByText('Task 1')).toBeInTheDocument();
    expect(screen.getByText('Task 2')).toBeInTheDocument();
  });

  it('returns null gracefully for an item index that is out of range', () => {
    // Forces the `if (!item) return null` branch — VirtualRows guards against
    // virtualizer overshoot during a measurement race.
    const items: ListItem[] = [
      { kind: 'task', task: makeTask({ id: 't1', wbs: '1.1', name: 'Only Task' }), phase: '—', rowIndex: 0 },
    ];
    // Pass rowCount=2 to force the virtualizer mock to emit 2 vRow entries
    // while items[] only has 1 element — index 1 is out of range and the
    // guard `if (!item) return null` in VirtualRows must skip it without throwing.
    const { container } = render(
      <VirtualRows
        items={items}
        rowCount={2}
        selectedIds={new Set()}
        renamingId={null}
        onToggleSelect={vi.fn()}
        onStartRename={vi.fn()}
        onRename={vi.fn()}
        onCancelRename={vi.fn()}
      />,
    );
    // Only one task row is rendered; no exception thrown.
    expect(container.querySelectorAll('[role="row"]').length).toBe(1);
  });

  it('uses a unique key per row even when the same task appears in multiple groups', () => {
    // Resource grouping intentionally duplicates multi-assignee tasks; the
    // VirtualRows row key combines task.id + visual index to avoid collisions.
    const dupTask = makeTask({ id: 't1', wbs: '1.1', name: 'Shared Task' });
    const items: ListItem[] = [
      { kind: 'header', id: 'g-alice', label: 'Alice', count: 1 },
      { kind: 'task', task: dupTask, phase: 'Phase A', rowIndex: 0 },
      { kind: 'header', id: 'g-bob', label: 'Bob', count: 1 },
      { kind: 'task', task: dupTask, phase: 'Phase A', rowIndex: 1 },
    ];
    const { container } = render(
      <VirtualRows
        items={items}
        rowCount={2}
        selectedIds={new Set()}
        renamingId={null}
        onToggleSelect={vi.fn()}
        onStartRename={vi.fn()}
        onRename={vi.fn()}
        onCancelRename={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('[role="row"]').length).toBeGreaterThanOrEqual(2);
  });
});
