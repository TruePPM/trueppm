import { useRef, type ComponentProps } from 'react';
import type React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/types';
import { useScheduleStore } from '@/stores/scheduleStore';
import { buildSiblingIdsMap, TaskListPanel } from './TaskListPanel';
import { stubCoarsePointer, restoreCoarsePointer } from '@/test/coarsePointer';
import { resolveOutlineLeftReserve, resolveNudgeLaneWidth } from './scheduleConstants';

/** Minimal task stub — buildSiblingIdsMap only reads `id` and `wbs`. */
function t(id: string, wbs: string): Task {
  return { id, wbs } as Task;
}

/** Naive O(n^2) reference oracle — the pre-optimization computeSiblingIds. */
function naiveSiblingIds(task: Task, all: Task[]): string[] {
  const level = task.wbs.split('.').length;
  const parent = task.wbs.split('.').slice(0, -1).join('.');
  return all
    .filter(
      (o) => o.wbs.split('.').length === level && o.wbs.split('.').slice(0, -1).join('.') === parent,
    )
    .map((o) => o.id);
}

describe('buildSiblingIdsMap', () => {
  const tasks = [
    t('a', '1'),
    t('b', '2'),
    t('c', '1.1'),
    t('d', '1.2'),
    t('e', '2.1'),
    t('f', '1.1.1'),
  ];

  it('groups each task with the other tasks sharing its WBS parent (self included)', () => {
    const map = buildSiblingIdsMap(tasks);
    // Roots '1' and '2' share parent '' → siblings [a, b].
    expect(new Set(map.get('a'))).toEqual(new Set(['a', 'b']));
    expect(new Set(map.get('b'))).toEqual(new Set(['a', 'b']));
    // '1.1' and '1.2' share parent '1' → [c, d]. '2.1' has parent '2' → [e] alone.
    expect(new Set(map.get('c'))).toEqual(new Set(['c', 'd']));
    expect(new Set(map.get('d'))).toEqual(new Set(['c', 'd']));
    expect(new Set(map.get('e'))).toEqual(new Set(['e']));
    // '1.1.1' has parent '1.1' with no siblings → itself only.
    expect(new Set(map.get('f'))).toEqual(new Set(['f']));
  });

  it('preserves task order within each sibling group', () => {
    const map = buildSiblingIdsMap(tasks);
    expect(map.get('a')).toEqual(['a', 'b']);
    expect(map.get('c')).toEqual(['c', 'd']);
  });

  it('returns identical sibling sets to the naive computeSiblingIds oracle', () => {
    const map = buildSiblingIdsMap(tasks);
    for (const task of tasks) {
      expect(new Set(map.get(task.id))).toEqual(new Set(naiveSiblingIds(task, tasks)));
    }
  });

  it('handles an empty list', () => {
    expect(buildSiblingIdsMap([]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TaskListPanel component tests.
//
// The real virtualizer measures the scroll element via ResizeObserver, which
// jsdom does not implement — so it renders zero rows. We replace it with a
// deterministic stub that emits one virtual item per task, and stub the two
// heavy children (header, row) so the assertions target THIS component's own
// logic: the sibling-name / name-suggestion / milestone-parent memoized maps,
// the per-row neighbour + focus-dim wiring, the pending-row block, and the
// scroll-to-task effect.
// ---------------------------------------------------------------------------

const virtual = vi.hoisted(() => ({ scrollToIndex: vi.fn(), measure: vi.fn() }));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: count }, (_unused, index) => ({ key: index, index, start: index * 28 })),
    scrollToIndex: virtual.scrollToIndex,
    // #2997: the panel re-measures when the pointer class flips the row height.
    measure: virtual.measure,
  }),
}));

vi.mock('./TaskListHeader', () => ({
  TaskListHeader: ({
    gripReserve,
    nudgeReserve,
  }: {
    gripReserve: number;
    nudgeReserve: number;
  }) => (
    <div
      data-testid="task-list-header"
      data-grip-reserve={gripReserve}
      data-nudge-reserve={nudgeReserve}
    />
  ),
}));

interface RowStubProps {
  gripReserve?: number;
  nudgeReserve?: number;
  task: Task;
  level: number;
  dimmed?: boolean;
  hasChildren?: boolean;
  isExpanded?: boolean;
  prevTaskId?: string | null;
  nextTaskId?: string | null;
  ariaRowIndex?: number;
  isActiveRow?: boolean;
  onFocusEdge?: (edge: 'first' | 'last') => void;
  siblingIds?: string[];
  siblingNames?: string[];
  nameSuggestions?: string[];
  milestoneParents?: { name: string; finish?: string }[];
  plannedBadge?: { count: number };
  isHovered?: boolean;
  sourceSprint?: { id: string; name: string; state: string } | null;
  phaseInWaiting?: boolean;
  startInlineEditOnMount?: boolean;
  onOutlineDragStart?: (taskId: string, e: React.PointerEvent) => void;
  isDragSource?: boolean;
  onMoveToRequest?: (taskId: string) => void;
}

vi.mock('./TaskListRow', () => ({
  TaskListRow: (props: RowStubProps) => (
    <div
      data-testid={`row-${props.task.id}`}
      data-level={props.level}
      data-dimmed={String(props.dimmed ?? false)}
      data-has-children={String(props.hasChildren ?? false)}
      data-expanded={String(props.isExpanded ?? false)}
      data-prev={props.prevTaskId ?? ''}
      data-next={props.nextTaskId ?? ''}
      data-aria-rowindex={props.ariaRowIndex ?? ''}
      data-active-row={String(props.isActiveRow ?? false)}
      data-has-focus-edge={String(Boolean(props.onFocusEdge))}
      data-grip-reserve={props.gripReserve ?? 0}
      data-nudge-reserve={props.nudgeReserve ?? 0}
      data-sibling-names={(props.siblingNames ?? []).join(',')}
      data-name-suggestions={(props.nameSuggestions ?? []).join('|')}
      data-milestone-parents={(props.milestoneParents ?? []).map((p) => p.name).join(',')}
      data-planned-count={props.plannedBadge ? String(props.plannedBadge.count) : ''}
      data-hovered={String(props.isHovered ?? false)}
      data-source-sprint={props.sourceSprint?.name ?? ''}
      data-phase-waiting={String(props.phaseInWaiting ?? false)}
      data-auto-edit={String(props.startInlineEditOnMount ?? false)}
      data-drag-source={String(props.isDragSource ?? false)}
      data-has-move-to={String(Boolean(props.onMoveToRequest))}
    >
      {props.task.name}
      {props.onOutlineDragStart && (
        <button
          type="button"
          data-testid={`grip-${props.task.id}`}
          onPointerDown={(e) => props.onOutlineDragStart?.(props.task.id, e)}
        >
          grip
        </button>
      )}
    </div>
  ),
}));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'x',
    wbs: '1',
    name: 'Task',
    isMilestone: false,
    ...overrides,
  } as Task;
}

const COLS = {
  widths: {} as never,
  visible: {} as never,
  setWidth: vi.fn(),
  totalWidth: 400,
};

function Harness(props: Omit<ComponentProps<typeof TaskListPanel>, 'scrollRef'>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return <TaskListPanel scrollRef={scrollRef} {...props} />;
}

function renderPanel(overrides: Partial<ComponentProps<typeof TaskListPanel>> = {}) {
  const props = {
    tasks: [task()],
    ...COLS,
    summaryIds: new Set<string>(),
    expandedIds: new Set<string>(),
    onToggle: vi.fn(),
    ...overrides,
  } as Omit<ComponentProps<typeof TaskListPanel>, 'scrollRef'>;
  return render(<Harness {...props} />);
}

beforeEach(() => {
  virtual.scrollToIndex.mockClear();
  useScheduleStore.setState({ scrollToTaskId: null });
});

describe('TaskListPanel — grid + row wiring', () => {
  it('renders the header and one row per task, with aria-rowcount matching', () => {
    renderPanel({
      tasks: [task({ id: 'a', name: 'Alpha' }), task({ id: 'b', wbs: '2', name: 'Beta' })],
    });
    expect(screen.getByTestId('task-list-header')).toBeInTheDocument();
    expect(screen.getByTestId('row-a')).toHaveTextContent('Alpha');
    expect(screen.getByTestId('row-b')).toHaveTextContent('Beta');
    // Header row (1) + one row per task (2) = 3 (#2204: aria-rowindex on the
    // header is 1 and on data rows is 2-based, so the count includes the header).
    expect(screen.getByRole('treegrid', { name: 'Item list' })).toHaveAttribute('aria-rowcount', '3');
  });

  it('assigns 2-based aria-rowindex to data rows (header is row 1) (#2204)', () => {
    renderPanel({
      tasks: [task({ id: 'a', name: 'Alpha' }), task({ id: 'b', wbs: '2', name: 'Beta' })],
    });
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-aria-rowindex', '2');
    expect(screen.getByTestId('row-b')).toHaveAttribute('data-aria-rowindex', '3');
  });

  it('makes exactly the first row the roving tab stop by default (#2204)', () => {
    renderPanel({
      tasks: [task({ id: 'a', name: 'Alpha' }), task({ id: 'b', wbs: '2', name: 'Beta' })],
    });
    // Roving tabindex: only one row is active (Tab-reachable) until focus moves.
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-active-row', 'true');
    expect(screen.getByTestId('row-b')).toHaveAttribute('data-active-row', 'false');
    // Each row receives the Home/End edge-jump callback.
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-has-focus-edge', 'true');
  });

  it('marks the layout wrappers presentation so grid → row ownership is intact (#2204)', () => {
    const { container } = renderPanel({ tasks: [task({ id: 'a', name: 'Alpha' })] });
    // No bare unroled div may sit between role="grid" and the rows; the scroll
    // wrapper, sizer, and per-row wrapper are all role="presentation".
    const grid = screen.getByRole('treegrid', { name: 'Item list' });
    const presentationWrappers = container.querySelectorAll('[role="presentation"]');
    expect(presentationWrappers.length).toBeGreaterThanOrEqual(3);
    // The active row still lives inside the grid subtree.
    expect(grid).toContainElement(screen.getByTestId('row-a'));
  });

  it('derives the WBS nesting level from the dotted wbs string', () => {
    renderPanel({ tasks: [task({ id: 'deep', wbs: '1.2.3', name: 'Deep' })] });
    // '1.2.3' → three segments → level 3.
    expect(screen.getByTestId('row-deep')).toHaveAttribute('data-level', '3');
  });

  it('passes prev/next neighbour ids for keyboard navigation (nulls at the edges)', () => {
    renderPanel({
      tasks: [
        task({ id: 'a', name: 'A' }),
        task({ id: 'b', wbs: '2', name: 'B' }),
        task({ id: 'c', wbs: '3', name: 'C' }),
      ],
    });
    // First row: no previous.
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-prev', '');
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-next', 'b');
    // Middle row: both neighbours.
    expect(screen.getByTestId('row-b')).toHaveAttribute('data-prev', 'a');
    expect(screen.getByTestId('row-b')).toHaveAttribute('data-next', 'c');
    // Last row: no next.
    expect(screen.getByTestId('row-c')).toHaveAttribute('data-prev', 'b');
    expect(screen.getByTestId('row-c')).toHaveAttribute('data-next', '');
  });

  it('marks rows as summary/expanded from the supplied id sets', () => {
    renderPanel({
      tasks: [task({ id: 'a', name: 'A' }), task({ id: 'b', wbs: '2', name: 'B' })],
      summaryIds: new Set(['a']),
      expandedIds: new Set(['a']),
    });
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-has-children', 'true');
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-expanded', 'true');
    // 'b' is neither.
    expect(screen.getByTestId('row-b')).toHaveAttribute('data-has-children', 'false');
    expect(screen.getByTestId('row-b')).toHaveAttribute('data-expanded', 'false');
  });
});

describe('TaskListPanel — focus mode dimming', () => {
  const tasks = [task({ id: 'a', name: 'A' }), task({ id: 'b', wbs: '2', name: 'B' })];

  it('dims rows outside a non-empty focus chain', () => {
    renderPanel({ tasks, focusChainIds: new Set(['a']) });
    // 'a' is in the chain → not dimmed; 'b' is outside → dimmed.
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-dimmed', 'false');
    expect(screen.getByTestId('row-b')).toHaveAttribute('data-dimmed', 'true');
  });

  it('dims nothing when the focus chain is empty (focus mode off)', () => {
    renderPanel({ tasks, focusChainIds: new Set() });
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-dimmed', 'false');
    expect(screen.getByTestId('row-b')).toHaveAttribute('data-dimmed', 'false');
  });

  it('dims nothing when no focus chain is provided at all', () => {
    renderPanel({ tasks });
    expect(screen.getByTestId('row-b')).toHaveAttribute('data-dimmed', 'false');
  });
});

describe('TaskListPanel — computed sibling names', () => {
  it('passes each row the names of its same-parent siblings (self included)', () => {
    renderPanel({
      tasks: [
        task({ id: 'a', wbs: '1', name: 'Alpha' }),
        task({ id: 'b', wbs: '2', name: 'Beta' }),
        task({ id: 'c', wbs: '1.1', name: 'Gamma' }),
      ],
    });
    // 'a' and 'b' are roots (parent '') → siblings [Alpha, Beta].
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-sibling-names', 'Alpha,Beta');
    // 'c' has parent '1' and no siblings → just itself.
    expect(screen.getByTestId('row-c')).toHaveAttribute('data-sibling-names', 'Gamma');
  });
});

describe('TaskListPanel — name suggestions', () => {
  it('lists milestone names first, then other names, de-duplicated', () => {
    renderPanel({
      tasks: [
        task({ id: 'a', wbs: '1', name: 'Regular', isMilestone: false }),
        task({ id: 'm', wbs: '2', name: 'Launch', isMilestone: true }),
        task({ id: 'dup', wbs: '3', name: 'Regular', isMilestone: false }),
      ],
    });
    // Milestone ('Launch') sorts ahead of non-milestones; the duplicate
    // 'Regular' appears once.
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-name-suggestions', 'Launch|Regular');
  });
});

describe('TaskListPanel — milestone parents', () => {
  it('resolves ancestor summary names (closest first) for milestone rows only', () => {
    renderPanel({
      tasks: [
        task({ id: 'p1', wbs: '1', name: 'Phase One' }),
        task({ id: 'p2', wbs: '1.2', name: 'Sub Phase' }),
        task({ id: 'ms', wbs: '1.2.3', name: 'Ship it', isMilestone: true }),
      ],
    });
    // Closest ancestor ('Sub Phase' at 1.2) first, then 'Phase One' at 1.
    expect(screen.getByTestId('row-ms')).toHaveAttribute(
      'data-milestone-parents',
      'Sub Phase,Phase One',
    );
    // A non-milestone row gets no parents entry.
    expect(screen.getByTestId('row-p2')).toHaveAttribute('data-milestone-parents', '');
  });

  it('skips ancestor levels whose WBS has no matching task', () => {
    renderPanel({
      // '1.2.3' milestone but no task at '1.2' — only the '1' ancestor exists.
      tasks: [
        task({ id: 'root', wbs: '1', name: 'Root' }),
        task({ id: 'ms', wbs: '1.2.3', name: 'Milestone', isMilestone: true }),
      ],
    });
    expect(screen.getByTestId('row-ms')).toHaveAttribute('data-milestone-parents', 'Root');
  });
});

describe('TaskListPanel — sprint / planned / phase-in-waiting / auto-edit wiring', () => {
  it('resolves the source sprint only when the task has a matching sprint id', () => {
    const sprintsById = new Map([['s1', { id: 's1', name: 'Sprint 7', state: 'ACTIVE' }]]);
    renderPanel({
      tasks: [
        task({ id: 'in', wbs: '1', name: 'In', sprintId: 's1' }),
        task({ id: 'miss', wbs: '2', name: 'Miss', sprintId: 'gone' }),
        task({ id: 'none', wbs: '3', name: 'None' }),
      ],
      sprintsById,
    });
    // Matching id → resolved snapshot name.
    expect(screen.getByTestId('row-in')).toHaveAttribute('data-source-sprint', 'Sprint 7');
    // Task has a sprintId but it is not in the lookup → null.
    expect(screen.getByTestId('row-miss')).toHaveAttribute('data-source-sprint', '');
    // No sprintId at all → null.
    expect(screen.getByTestId('row-none')).toHaveAttribute('data-source-sprint', '');
  });

  it('passes the per-phase planned badge only to the keyed summary rows', () => {
    const plannedByPhase = new Map([
      ['p', { count: 4, primarySprintId: 's1', sprintNames: ['Sprint 7'] }],
    ]);
    renderPanel({
      tasks: [task({ id: 'p', wbs: '1', name: 'Phase' }), task({ id: 'q', wbs: '2', name: 'Other' })],
      plannedByPhase,
    });
    expect(screen.getByTestId('row-p')).toHaveAttribute('data-planned-count', '4');
    // A phase with no planned work is absent from the map → no badge.
    expect(screen.getByTestId('row-q')).toHaveAttribute('data-planned-count', '');
  });

  it('flags phase-in-waiting rows and the auto-edit target row', () => {
    renderPanel({
      tasks: [task({ id: 'a', wbs: '1', name: 'A' }), task({ id: 'b', wbs: '2', name: 'B' })],
      phaseInWaitingIds: new Set(['a']),
      autoEditTaskId: 'b',
    });
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-phase-waiting', 'true');
    expect(screen.getByTestId('row-b')).toHaveAttribute('data-phase-waiting', 'false');
    // autoEdit target only.
    expect(screen.getByTestId('row-b')).toHaveAttribute('data-auto-edit', 'true');
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-auto-edit', 'false');
  });
});

describe('TaskListPanel — pending scheduler rows', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a spinner row for each pending task before the timeout', () => {
    renderPanel({
      tasks: [task({ id: 'a', name: 'Scheduled' })],
      pendingTaskIds: new Map([['p1', 'New item']]),
    });
    expect(screen.getByRole('row', { name: /New item, pending scheduling/i })).toBeInTheDocument();
    expect(screen.getByText('Scheduling…')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: /Scheduling in progress/i })).toBeInTheDocument();
    // The "Pending schedule" fallback has not appeared yet.
    expect(screen.queryByText('Pending schedule')).toBeNull();
  });

  it('swaps the spinner for a "Pending schedule" label after 8 seconds', () => {
    vi.useFakeTimers();
    try {
      renderPanel({
        tasks: [task({ id: 'a', name: 'Scheduled' })],
        pendingTaskIds: new Map([['p1', 'Slow task']]),
      });
      expect(screen.getByText('Scheduling…')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(8000);
      });
      expect(screen.getByText('Pending schedule')).toBeInTheDocument();
      expect(screen.queryByText('Scheduling…')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders no pending block when the pending map is empty', () => {
    renderPanel({
      tasks: [task({ id: 'a', name: 'Scheduled' })],
      pendingTaskIds: new Map(),
    });
    expect(screen.queryByText('Scheduling…')).toBeNull();
    expect(screen.queryByRole('row', { name: /pending scheduling/i })).toBeNull();
  });
});

describe('TaskListPanel — scroll-to-task effect (issue #32)', () => {
  it('scrolls the matching task index into view and clears the request', () => {
    renderPanel({
      tasks: [
        task({ id: 'a', wbs: '1', name: 'A' }),
        task({ id: 'b', wbs: '2', name: 'B' }),
        task({ id: 'c', wbs: '3', name: 'C' }),
      ],
    });
    act(() => {
      useScheduleStore.getState().scrollToTask('c');
    });
    // 'c' is index 2 → scrollToIndex(2, center); request is then reset.
    expect(virtual.scrollToIndex).toHaveBeenCalledWith(2, { align: 'center' });
    expect(useScheduleStore.getState().scrollToTaskId).toBeNull();
  });

  it('clears an unknown scroll request without calling scrollToIndex', () => {
    renderPanel({ tasks: [task({ id: 'a', name: 'A' })] });
    act(() => {
      useScheduleStore.getState().scrollToTask('does-not-exist');
    });
    expect(virtual.scrollToIndex).not.toHaveBeenCalled();
    // The request is still consumed so it does not fire again on the next render.
    expect(useScheduleStore.getState().scrollToTaskId).toBeNull();
  });
});

describe('TaskListPanel — blank project draft row (#2733)', () => {
  it('renders a live draft row when the outline is empty', async () => {
    // The "No items yet" card is gone: an empty outline opens with the caret in
    // row 1, so the first keystroke is the first task rather than the third click.
    const onCommitDraftRow = vi.fn();
    renderPanel({ tasks: [], onCommitDraftRow });

    const draft = await screen.findByRole('textbox', { name: /first item name/i });
    await userEvent.type(draft, 'Survey the site{Enter}');

    expect(onCommitDraftRow).toHaveBeenCalledTimes(1);
    expect(onCommitDraftRow.mock.calls[0][0]).toBe('Survey the site');
  });

  it('does not render the draft row once the outline has tasks', () => {
    renderPanel({ tasks: [task()], onCommitDraftRow: vi.fn() });
    expect(screen.queryByRole('textbox', { name: /first item name/i })).toBeNull();
  });

  it('renders a static line, not an input, without a commit handler', () => {
    // Read-only roles: a caret in a field that cannot save is worse than no caret.
    renderPanel({ tasks: [] });
    expect(screen.queryByRole('textbox', { name: /first item name/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Drag to reorder or reparent (#2954) — the panel owns the session, because it
// is the only thing that can answer "what row is under the pointer now".
// ---------------------------------------------------------------------------

describe('TaskListPanel — the outline drag session', () => {
  const TASKS = [
    task({ id: 'phase', wbs: '1', name: 'Mobilization' }),
    task({ id: 'a', wbs: '1.1', name: 'Survey', parentId: 'phase' }),
    task({ id: 'tail', wbs: '2', name: 'Closeout' }),
  ];
  const summaryIds = new Set(['phase']);

  /** Press the grip, then travel — the threshold is what turns a press into a drag. */
  function dragFrom(id: string, toClientY: number) {
    fireEvent.pointerDown(screen.getByTestId(`grip-${id}`), { clientY: 0, button: 0 });
    act(() => {
      const move = new Event('pointermove', { bubbles: true, cancelable: true });
      Object.assign(move, { clientY: toClientY, clientX: 0 });
      window.dispatchEvent(move);
    });
  }

  it('offers no gesture at all when nothing can commit one', () => {
    // Rule 302 in the panel's own terms: without a commit sink there is no
    // capability, so there is no affordance either — not a dead one.
    renderPanel({ tasks: TASKS, summaryIds });
    expect(screen.queryByTestId('grip-a')).not.toBeInTheDocument();
  });

  it('wires the gesture up when one can', () => {
    renderPanel({ tasks: TASKS, summaryIds, onMoveRow: vi.fn() });
    expect(screen.getByTestId('grip-a')).toBeInTheDocument();
  });

  it('draws the consequence of the drop under the pointer', () => {
    renderPanel({ tasks: TASKS, summaryIds, onMoveRow: vi.fn() });
    // Row 2 ("Closeout") is a leaf — dropping onto it makes it a phase.
    dragFrom('a', 2 * 28 + 14);
    expect(screen.getByTestId('outline-drop-consequence')).toHaveTextContent('↳ becomes a phase');
  });

  it('marks the row being dragged, so the source is not ambiguous', () => {
    renderPanel({ tasks: TASKS, summaryIds, onMoveRow: vi.fn() });
    dragFrom('a', 2 * 28 + 14);
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-drag-source', 'true');
    expect(screen.getByTestId('row-tail')).toHaveAttribute('data-drag-source', 'false');
  });

  it('commits the plan on release', () => {
    const onMoveRow = vi.fn();
    renderPanel({ tasks: TASKS, summaryIds, onMoveRow });
    dragFrom('a', 2 * 28 + 14);
    act(() => {
      const up = new Event('pointerup', { bubbles: true, cancelable: true });
      Object.assign(up, { clientY: 2 * 28 + 14, clientX: 0 });
      window.dispatchEvent(up);
    });
    expect(onMoveRow).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'a', newParentId: 'tail', becomesPhase: true }),
    );
  });

  it('passes "Move to…" down only when it can be honoured', () => {
    const { unmount } = renderPanel({ tasks: TASKS, summaryIds });
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-has-move-to', 'false');
    unmount();
    renderPanel({ tasks: TASKS, summaryIds, onMoveToRequest: vi.fn() });
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-has-move-to', 'true');
  });
});


/**
 * #2997 — the row pitch is a runtime value, and two things have to move with it.
 */
describe('TaskListPanel — the row pitch follows the pointer class (#2997)', () => {
  afterEach(restoreCoarsePointer);

  it('re-measures the virtualizer when the pointer class flips mid-session', () => {
    const mq = stubCoarsePointer(false);
    renderPanel({ tasks: [task({ id: 'a' }), task({ id: 'b', wbs: '2' })] });
    virtual.measure.mockClear();

    act(() => mq.flip(true));

    // TanStack Virtual caches every measured size. Changing `estimateSize`
    // alone leaves the old 28px offsets in place while each row's own box grows
    // to 44 — the rows then overlap. Re-measuring is what actually moves them,
    // and no other test on this branch would notice if the effect were deleted.
    expect(virtual.measure).toHaveBeenCalled();
  });

  it('hands the header and every row the SAME grip lane', () => {
    stubCoarsePointer(true);
    renderPanel({
      tasks: [task({ id: 'a' }), task({ id: 'b', wbs: '2' })],
      onMoveRow: vi.fn(),
    });
    // One number from one place. Each of these renders the spacer itself, so a
    // lane resolved per component is a table whose columns do not line up — and
    // it would look like a rendering bug, not a missing constant.
    expect(screen.getByTestId('task-list-header')).toHaveAttribute('data-grip-reserve', '44');
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-grip-reserve', '44');
    expect(screen.getByTestId('row-b')).toHaveAttribute('data-grip-reserve', '44');
  });

  it('reserves nothing when no move can be committed — a viewer keeps the width', () => {
    stubCoarsePointer(true);
    renderPanel({ tasks: [task({ id: 'a' })] }); // no onMoveRow → no grip anywhere
    // Web rule 302 makes the apparatus absent for a viewer; a 44px lane held for
    // a control that is not rendered costs ~15% of the name column for nothing.
    expect(screen.getByTestId('task-list-header')).toHaveAttribute('data-grip-reserve', '0');
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-grip-reserve', '0');
  });

  it('gives a pending row the same lane, so it does not jump when it schedules', () => {
    stubCoarsePointer(true);
    renderPanel({
      tasks: [task({ id: 'a' })],
      onMoveRow: vi.fn(),
      pendingTaskIds: new Map([['p1', 'Newly typed row']]),
    });
    const pending = screen.getByRole('row', { name: /pending scheduling/ });
    const lane = pending.firstElementChild as HTMLElement;
    expect(lane.getAttribute('aria-hidden')).toBe('true');
    // BOTH lanes (#3026) — a pending row that spaced by the grip alone would
    // slide left by the nudge lane the instant the scheduler answered.
    expect(lane.style.width).toBe(`${resolveOutlineLeftReserve(true, true)}px`);
  });

  it('hands the header and every row the SAME nudge lane (#3026)', () => {
    stubCoarsePointer(true);
    renderPanel({
      tasks: [task({ id: 'a' }), task({ id: 'b', wbs: '2' })],
      onMoveRow: vi.fn(),
    });
    // Same invariant as the grip lane above, for the same reason: the header and
    // the rows each render the spacer themselves, so a lane resolved per
    // component is a table whose columns do not line up.
    const lane = String(resolveNudgeLaneWidth(true));
    expect(screen.getByTestId('task-list-header')).toHaveAttribute('data-nudge-reserve', lane);
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-nudge-reserve', lane);
    expect(screen.getByTestId('row-b')).toHaveAttribute('data-nudge-reserve', lane);
  });

  it('gives a VIEWER no nudge lane — absence, not a reserved hole (#3026)', () => {
    stubCoarsePointer(true);
    renderPanel({ tasks: [task({ id: 'a' })] }); // no onMoveRow → nothing to nudge
    expect(screen.getByTestId('task-list-header')).toHaveAttribute('data-nudge-reserve', '0');
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-nudge-reserve', '0');
  });

  it('reserves nothing on a fine pointer even when the grip is there', () => {
    stubCoarsePointer(false);
    renderPanel({ tasks: [task({ id: 'a' })], onMoveRow: vi.fn() });
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-grip-reserve', '0');
  });
});

// ---------------------------------------------------------------------------
// Append at the end (#2957) — the third of the three insert affordances. The
// panel's job here is purely positional: the row lives at the end of the list,
// counts as a treegrid row, and disappears entirely without edit rights.
// ---------------------------------------------------------------------------

describe('TaskListPanel — append-at-the-end footer (#2957)', () => {
  it('renders the footer after every task row and counts it in aria-rowcount', () => {
    renderPanel({
      tasks: [task({ id: 'a', name: 'Alpha' }), task({ id: 'b', wbs: '2', name: 'Beta' })],
      onAppendTaskAtEnd: vi.fn(),
    });
    const footer = screen.getByTestId('schedule-append-task-footer');
    expect(footer).toBeInTheDocument();
    // Header (1) + two tasks (2,3) + footer (4).
    expect(screen.getByRole('treegrid', { name: 'Item list' })).toHaveAttribute(
      'aria-rowcount',
      '4',
    );
    expect(footer).toHaveAttribute('aria-rowindex', '4');
    // Positionally last: every task row precedes it in document order.
    expect(
      screen.getByTestId('row-b').compareDocumentPosition(footer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('appends at the top level, whichever row is the roving stop', async () => {
    const onAppendTaskAtEnd = vi.fn();
    renderPanel({
      tasks: [task({ id: 'a', name: 'Alpha' }), task({ id: 'b', wbs: '1.1', name: 'Nested' })],
      onAppendTaskAtEnd,
    });
    // The footer takes no task id at all — there is nothing for a cursor to
    // change about where it lands, which is the point (#2957).
    await userEvent.click(screen.getByRole('button', { name: 'Add an item at the end' }));
    expect(onAppendTaskAtEnd).toHaveBeenCalledExactlyOnceWith();
    expect(screen.getByTestId('schedule-append-task-footer')).toHaveAttribute('aria-level', '1');
  });

  it('passes Read mode through to the footer — present, inert, explained', () => {
    renderPanel({
      tasks: [task({ id: 'a', name: 'Alpha' })],
      onAppendTaskAtEnd: vi.fn(),
      appendAtEndReadOnly: true,
    });
    const btn = screen.getByRole('button', { name: 'Add an item at the end' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Read-only access');
  });

  it('is absent without a handler — no dimmed control for a reader with no rights', () => {
    renderPanel({ tasks: [task({ id: 'a', name: 'Alpha' })] });
    expect(screen.queryByTestId('schedule-append-task-footer')).toBeNull();
    expect(screen.getByRole('treegrid', { name: 'Item list' })).toHaveAttribute(
      'aria-rowcount',
      '2',
    );
  });

  it('stays out of a blank project, where the draft row already holds the caret', () => {
    renderPanel({ tasks: [], onAppendTaskAtEnd: vi.fn(), onCommitDraftRow: vi.fn() });
    expect(screen.queryByTestId('schedule-append-task-footer')).toBeNull();
  });
});
