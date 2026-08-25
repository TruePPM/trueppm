import { useRef, type ComponentProps } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/types';
import { useScheduleStore } from '@/stores/scheduleStore';
import { ROW_HEIGHT } from './scheduleConstants';
import { TaskListPanel } from './TaskListPanel';

// ---------------------------------------------------------------------------
// Roving-tabindex / Home-End edge focus (#2204).
//
// These paths need a virtualizer that renders a WINDOW of rows rather than all
// of them: the whole point of focusEdgeRow's deferred branch is that the edge
// row is outside the rendered window, so the panel scrolls to it and focuses it
// once it mounts. The stub below therefore renders only `windowSize` rows and
// (optionally) widens that window when scrollToIndex is called, reproducing the
// real virtualizer's behavior closely enough to drive both branches.
// ---------------------------------------------------------------------------

const virt = vi.hoisted(() => {
  const state = {
    windowSize: 100,
    widenOnScroll: true,
    scrollElements: [] as (Element | null)[],
    estimatedSizes: [] as number[],
    scrollToIndex: vi.fn<(index: number, opts?: { align?: string }) => void>(),
    measure: vi.fn(),
  };
  state.scrollToIndex.mockImplementation((index) => {
    if (state.widenOnScroll) state.windowSize = Math.max(state.windowSize, index + 1);
  });
  return state;
});

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: {
    count: number;
    getScrollElement: () => Element | null;
    estimateSize: () => number;
  }) => {
    virt.scrollElements.push(opts.getScrollElement());
    virt.estimatedSizes.push(opts.estimateSize());
    const shown = Math.min(opts.count, virt.windowSize);
    return {
      getTotalSize: () => opts.count * ROW_HEIGHT,
      getVirtualItems: () =>
        Array.from({ length: shown }, (_unused, index) => ({
          key: index,
          index,
          start: index * ROW_HEIGHT,
        })),
      scrollToIndex: virt.scrollToIndex,
      // #2997: the panel re-measures when the pointer class flips the row
      // height. A mock without it throws on mount rather than failing an
      // assertion, which is the stale-mock class the project CLAUDE.md warns of.
      measure: virt.measure,
    };
  },
}));

vi.mock('./TaskListHeader', () => ({
  TaskListHeader: () => <div data-testid="task-list-header" />,
}));

interface RowStubProps {
  task: Task;
  isActiveRow?: boolean;
  onRowFocus?: (id: string) => void;
  onFocusEdge?: (edge: 'first' | 'last') => void;
}

// The real row roots carry `data-row-id` and are focusable — the panel's
// deferred-focus effect finds them with exactly that selector, so the stub must
// too or the behavior under test cannot happen.
vi.mock('./TaskListRow', () => ({
  TaskListRow: (props: RowStubProps) => (
    <div
      data-testid={`row-${props.task.id}`}
      data-row-id={props.task.id}
      data-active-row={String(props.isActiveRow ?? false)}
      tabIndex={-1}
    >
      <button type="button" onClick={() => props.onFocusEdge?.('first')}>
        {`home-${props.task.id}`}
      </button>
      <button type="button" onClick={() => props.onFocusEdge?.('last')}>
        {`end-${props.task.id}`}
      </button>
      <button type="button" onClick={() => props.onRowFocus?.(props.task.id)}>
        {`focus-${props.task.id}`}
      </button>
    </div>
  ),
}));

function task(id: string, wbs: string): Task {
  return { id, wbs, name: id.toUpperCase(), isMilestone: false } as Task;
}

const FIVE = [task('a', '1'), task('b', '2'), task('c', '3'), task('d', '4'), task('e', '5')];

function Harness(props: Omit<ComponentProps<typeof TaskListPanel>, 'scrollRef'>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return <TaskListPanel scrollRef={scrollRef} {...props} />;
}

function renderPanel(tasks: Task[]) {
  return render(
    <Harness
      tasks={tasks}
      widths={{} as never}
      visible={{} as never}
      setWidth={vi.fn()}
      totalWidth={400}
      summaryIds={new Set<string>()}
      expandedIds={new Set<string>()}
      onToggle={vi.fn()}
    />,
  );
}

beforeEach(() => {
  virt.scrollToIndex.mockClear();
  virt.scrollElements.length = 0;
  virt.estimatedSizes.length = 0;
  virt.windowSize = 100;
  virt.widenOnScroll = true;
  useScheduleStore.setState({ scrollToTaskId: null });
});

describe('TaskListPanel — virtualizer wiring', () => {
  it('measures the element that actually scrolls the rows, at the fixed row height', () => {
    renderPanel(FIVE);
    // The ref is only populated after the first commit, so read what the
    // virtualizer is handed on a subsequent render.
    fireEvent.click(screen.getByRole('button', { name: 'focus-a' }));
    const measured = virt.scrollElements.filter((el): el is Element => el !== null).at(-1);
    expect(measured).toBeDefined();
    // The reported scroll element is the one the rows live inside — not the
    // outer grid, and not the absolutely-positioned row wrapper.
    expect(measured).toContainElement(screen.getByTestId('row-a'));
    expect(new Set(virt.estimatedSizes)).toEqual(new Set([ROW_HEIGHT]));
  });
});

describe('TaskListPanel — empty task list', () => {
  it('renders a grid with only the header row and no active row', () => {
    const { container } = renderPanel([]);
    expect(screen.getByTestId('task-list-header')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-row-id]')).toHaveLength(0);
    // Header row only — no data rows to count.
    expect(screen.getByRole('treegrid', { name: 'Item list' })).toHaveAttribute('aria-rowcount', '1');
  });
});

describe('TaskListPanel — roving tab stop', () => {
  it('moves the single tab stop to whichever row reports focus', () => {
    renderPanel(FIVE);
    // Falls back to the first task until a row reports focus.
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-active-row', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'focus-c' }));

    expect(screen.getByTestId('row-c')).toHaveAttribute('data-active-row', 'true');
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-active-row', 'false');
  });
});

describe('TaskListPanel — Home/End edge jump', () => {
  it('End scrolls the last row into view, focuses it, and moves the tab stop', () => {
    renderPanel(FIVE);

    fireEvent.click(screen.getByRole('button', { name: 'end-a' }));

    expect(virt.scrollToIndex).toHaveBeenCalledWith(4, { align: 'end' });
    expect(document.activeElement).toBe(screen.getByTestId('row-e'));
    expect(screen.getByTestId('row-e')).toHaveAttribute('data-active-row', 'true');
  });

  it('Home scrolls back to the first row, focuses it, and moves the tab stop', () => {
    renderPanel(FIVE);
    fireEvent.click(screen.getByRole('button', { name: 'focus-d' }));

    fireEvent.click(screen.getByRole('button', { name: 'home-d' }));

    expect(virt.scrollToIndex).toHaveBeenCalledWith(0, { align: 'start' });
    expect(document.activeElement).toBe(screen.getByTestId('row-a'));
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-active-row', 'true');
  });

  it('defers the focus until the edge row mounts when it is outside the window', () => {
    // Only the first two of five rows are rendered, so the End target does not
    // exist in the DOM at click time — the panel must focus it after it mounts.
    virt.windowSize = 2;
    renderPanel(FIVE);
    expect(screen.queryByTestId('row-e')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'end-a' }));

    expect(screen.getByTestId('row-e')).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTestId('row-e'));
  });

  it('holds the deferred focus request until the edge row finally mounts', () => {
    // Scrolling does not widen the window here, so the row stays unmounted and
    // the pending request must survive the intervening render rather than being
    // dropped or throwing.
    virt.windowSize = 2;
    virt.widenOnScroll = false;
    renderPanel(FIVE);

    fireEvent.click(screen.getByRole('button', { name: 'end-a' }));
    expect(screen.queryByTestId('row-e')).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByTestId('row-a'));

    // The row mounts on a later render — the panel claims focus then.
    virt.windowSize = 5;
    fireEvent.click(screen.getByRole('button', { name: 'focus-a' }));

    expect(document.activeElement).toBe(screen.getByTestId('row-e'));
  });
});
