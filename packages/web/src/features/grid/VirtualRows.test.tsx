import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VirtualRows, type ListItem } from './VirtualRows';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import type { Task } from '@/types';

// Breakpoint drives the fixed virtual-row height (44px desktop / 56px mobile).
// Default to desktop; the mobile-height test overrides per-case.
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: vi.fn(() => 'lg') }));

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return this; } };
    },
  });
});

vi.mock('@tanstack/react-virtual', () => ({
  // The mock emits one virtual row per `count` (which VirtualRows derives from
  // items.length), so every list item renders inline for DOM-order assertions.
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

  it('renders one row per item without throwing', () => {
    // The `if (!item) return null` guard in VirtualRows protects against
    // virtualizer overshoot during a measurement race; with a single item the
    // body renders exactly one row and nothing throws.
    const items: ListItem[] = [
      { kind: 'task', task: makeTask({ id: 't1', wbs: '1.1', name: 'Only Task' }), phase: '—', rowIndex: 0 },
    ];
    const { container } = render(
      <VirtualRows
        items={items}
        selectedIds={new Set()}
        renamingId={null}
        onToggleSelect={vi.fn()}
        onStartRename={vi.fn()}
        onRename={vi.fn()}
        onCancelRename={vi.fn()}
      />,
    );
    // Only one task row is rendered; no exception thrown. The absolutely
    // positioned layout wrappers are role="presentation", not role="row".
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

  it('positions task rows at the taller card height on mobile (#1701)', () => {
    vi.mocked(useBreakpoint).mockReturnValue('sm');
    const items: ListItem[] = [
      { kind: 'task', task: makeTask({ id: 't1', wbs: '1.1', name: 'Task 1' }), phase: 'Phase A', rowIndex: 0 },
    ];
    const { container } = render(
      <VirtualRows
        items={items}
        selectedIds={new Set()}
        renamingId={null}
        onToggleSelect={vi.fn()}
        onStartRename={vi.fn()}
        onRename={vi.fn()}
        onCancelRename={vi.fn()}
      />,
    );
    // The absolutely positioned layout wrapper (role="presentation", parent of the
    // aria-rowindex row) is sized to the mobile estimate (56px), so the two-line
    // card is never clipped by a 44px desktop-height slot. aria-rowindex now lives
    // on the row itself (#2204), so the height is read from its parent wrapper.
    const row = container.querySelector('[aria-rowindex="1"]') as HTMLElement;
    expect((row.parentElement as HTMLElement).style.height).toBe('56px');
    vi.mocked(useBreakpoint).mockReturnValue('lg');
  });
});
