/**
 * SprintClosedOutcome — demo-list drag-to-reorder behavior (#1130).
 *
 * dnd-kit's pointer/keyboard sensors need real layout rects, which jsdom does not
 * provide, so this companion suite replaces the dnd-kit modules with thin stubs
 * that (a) hand us the `onDragEnd` callback the DemoSortableList registers and
 * (b) let a test declare which row is mid-drag. Everything asserted below is the
 * component's own behavior: what order gets persisted, the guards that make a
 * stray drop a no-op, and the mid-drag row styling.
 *
 * It lives beside SprintClosedOutcome.test.tsx rather than inside it because
 * `vi.mock` is file-scoped — stubbing dnd-kit there would strip the real sortable
 * wiring from every other test in that suite.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { renderWithProvidersAndRouter as render } from '@/test/utils';

import { SprintClosedOutcome } from './SprintClosedOutcome';
import type { SprintOutcome } from '@/hooks/useSprints';

/** Minimal shape of the drag-end event the component actually reads. */
interface StubDragEndEvent {
  active: { id: string };
  over: { id: string } | null;
}
type DragEndHandler = (event: StubDragEndEvent) => void;

const dnd = vi.hoisted(() => ({
  /** Every `onDragEnd` registered during the latest render pass. */
  handlers: [] as unknown[],
  /** Ids the sortable stub should report as currently being dragged. */
  dragging: new Set<string>(),
}));

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }: { children: ReactNode; onDragEnd: DragEndHandler }) => {
    dnd.handlers.push(onDragEnd);
    return <>{children}</>;
  },
  closestCenter: () => [],
  useSensor: () => ({}),
  useSensors: (...sensors: unknown[]) => sensors,
  KeyboardSensor: {},
  PointerSensor: {},
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <>{children}</>,
  sortableKeyboardCoordinates: () => undefined,
  verticalListSortingStrategy: 'vertical',
  arrayMove: <T,>(items: T[], from: number, to: number) => {
    const next = items.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  },
  useSortable: ({ id }: { id: string }) => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => undefined,
    transform: null,
    transition: undefined,
    isDragging: dnd.dragging.has(id),
  }),
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

const reorderMutate = vi.fn<(vars: { outcomeIds: string[] }) => void>();
vi.mock('@/hooks/useSprints', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useSprints')>()),
  useToggleDemo: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useReorderDemoList: () => ({ mutate: reorderMutate, isPending: false, isError: false }),
  useSetPresenter: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useSetReviewNote: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useFlagForBacklog: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

beforeEach(() => {
  reorderMutate.mockClear();
  dnd.handlers.length = 0;
  dnd.dragging.clear();
});

function shippedStory(
  over: Partial<SprintOutcome['review']['shipped'][number]> = {},
): SprintOutcome['review']['shipped'][number] {
  return {
    outcome_id: 'o1',
    task_id: 't9',
    task_short_id: 'T-200',
    task_title: 'Checkout flow',
    story_points: 8,
    acceptance: { met: 3, total: 3 },
    unmet_criteria: [],
    review_note: '',
    flagged_to_backlog: false,
    demo_ready: false,
    demo_order: 0,
    presenter: '',
    ...over,
  };
}

/** Three demo-flagged stories in server demo_order: o-a, o-b, o-c. */
function threeDemoOutcome(): SprintOutcome {
  return {
    sprint_id: 's1',
    state: 'COMPLETED',
    provisional: false,
    outcome_recorded: true,
    name: 'Sprint 7',
    start_date: '2026-04-01',
    finish_date: '2026-04-14',
    closed_at: '2026-04-14T00:00:00Z',
    goal: 'Ship checkout',
    goal_outcome: 'MET',
    commitment: {
      committed_points: 34,
      committed_task_count: 12,
      completed_points: 28,
      completed_task_count: 9,
      completion_ratio_points: 0.82,
      completion_ratio_tasks: 0.75,
    },
    velocity: null,
    didnt_ship: [],
    didnt_ship_summary: { carried_count: 0, carried_points: 0, dropped_count: 0, dropped_points: 0 },
    retro_summary: null,
    review: {
      accepted_count: 3,
      not_accepted_count: 0,
      no_criteria_count: 0,
      accepted_points: null,
      not_accepted_points: null,
      shipped: [
        shippedStory({ outcome_id: 'o-a', task_short_id: 'T-1', task_title: 'Alpha story', demo_ready: true, demo_order: 0 }),
        shippedStory({ outcome_id: 'o-b', task_short_id: 'T-2', task_title: 'Beta story', demo_ready: true, demo_order: 1 }),
        shippedStory({ outcome_id: 'o-c', task_short_id: 'T-3', task_title: 'Gamma story', demo_ready: true, demo_order: 2 }),
      ],
      demo_list: ['o-a', 'o-b', 'o-c'],
      commitment: { committed_count: 3, shipped_count: 3, carried_count: 0 },
    },
    milestone_slip: null,
  };
}

/** The single onDragEnd the DemoSortableList registered on the last render. */
function dragEnd(): DragEndHandler {
  expect(dnd.handlers).toHaveLength(1);
  return dnd.handlers[0] as DragEndHandler;
}

describe('SprintClosedOutcome — demo drag reorder (#1130)', () => {
  it('persists the complete demo set in its new order when a row is dropped', () => {
    render(<SprintClosedOutcome outcome={threeDemoOutcome()} canCurateDemo />);
    act(() => {
      dragEnd()({ active: { id: 'o-c' }, over: { id: 'o-a' } });
    });
    // Gamma moved to the head; the whole ordered set is written, not just the delta.
    expect(reorderMutate).toHaveBeenCalledWith({ outcomeIds: ['o-c', 'o-a', 'o-b'] });
  });

  it('persists a downward move with the intermediate rows shifted up', () => {
    render(<SprintClosedOutcome outcome={threeDemoOutcome()} canCurateDemo />);
    act(() => {
      dragEnd()({ active: { id: 'o-a' }, over: { id: 'o-c' } });
    });
    expect(reorderMutate).toHaveBeenCalledWith({ outcomeIds: ['o-b', 'o-c', 'o-a'] });
  });

  it('is a no-op when the row is dropped outside any sortable target', () => {
    render(<SprintClosedOutcome outcome={threeDemoOutcome()} canCurateDemo />);
    act(() => {
      dragEnd()({ active: { id: 'o-a' }, over: null });
    });
    expect(reorderMutate).not.toHaveBeenCalled();
  });

  it('is a no-op when the row is dropped back onto itself', () => {
    render(<SprintClosedOutcome outcome={threeDemoOutcome()} canCurateDemo />);
    act(() => {
      dragEnd()({ active: { id: 'o-b' }, over: { id: 'o-b' } });
    });
    expect(reorderMutate).not.toHaveBeenCalled();
  });

  it('is a no-op when the dragged id is not part of the demo set', () => {
    render(<SprintClosedOutcome outcome={threeDemoOutcome()} canCurateDemo />);
    act(() => {
      dragEnd()({ active: { id: 'not-a-demo-row' }, over: { id: 'o-a' } });
    });
    expect(reorderMutate).not.toHaveBeenCalled();
  });

  it('is a no-op when the drop target is not part of the demo set', () => {
    render(<SprintClosedOutcome outcome={threeDemoOutcome()} canCurateDemo />);
    act(() => {
      dragEnd()({ active: { id: 'o-a' }, over: { id: 'not-a-demo-row' } });
    });
    expect(reorderMutate).not.toHaveBeenCalled();
  });

  it('lifts the mid-drag row visually while it is being dragged', () => {
    dnd.dragging.add('o-b');
    render(<SprintClosedOutcome outcome={threeDemoOutcome()} canCurateDemo />);
    const rows = screen.getByTestId('sprint-review').querySelectorAll('li');
    expect(rows[0].className).not.toContain('opacity-70');
    expect(rows[1].className).toContain('opacity-70');
    expect(rows[1].className).toContain('bg-neutral-surface-raised');
  });

  it('registers no drag context at all for a read-only viewer', () => {
    render(<SprintClosedOutcome outcome={threeDemoOutcome()} canCurateDemo={false} />);
    expect(dnd.handlers).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Reorder demo:/i })).toBeNull();
  });
});
