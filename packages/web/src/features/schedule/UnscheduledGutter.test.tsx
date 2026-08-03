/**
 * UnscheduledGutter unit tests — two-section tray (#318, rule 132/133).
 *
 * Covers:
 *  - partition of the task list into a To Do section (NOT_STARTED) and a
 *    Backlog section (status === 'BACKLOG')
 *  - summed header count
 *  - per-section role="status" empty rows (never hide one while the other fills)
 *  - backlog chips carry the dashed left edge + readiness label variant
 */
import { act, screen, within, waitFor, fireEvent, render as rtlRender } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRef, type ReactElement, type RefObject } from 'react';
import type { ApiSprint, Task } from '@/types';
import type { GanttScaleData } from './engine';
import { UnscheduledGutter } from './UnscheduledGutter';
import { formatShortDate } from './scheduleUtils';
import { useScheduleStore } from '@/stores/scheduleStore';

const { patchMock } = vi.hoisted(() => ({
  patchMock: vi.fn(() => Promise.resolve({ data: {} })),
}));

vi.mock('@/api/client', () => ({
  apiClient: { patch: patchMock },
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Task',
    start: '',
    finish: '',
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
    ...overrides,
  };
}

function makeSprint(overrides: Partial<ApiSprint> & { id: string }): ApiSprint {
  return {
    name: 'Sprint',
    state: 'PLANNED',
    start_date: '2026-07-17',
    finish_date: '2026-07-30',
    ...overrides,
  } as unknown as ApiSprint;
}

function renderGutter(tasks: Task[], sprints?: ApiSprint[]): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const canvasScrollRef = createRef<HTMLDivElement>();
  const ui: ReactElement = (
    <QueryClientProvider client={qc}>
      <UnscheduledGutter
        tasks={tasks}
        projectId="proj1"
        scaleData={null}
        canvasScrollRef={canvasScrollRef}
        taskListWidth={200}
        sprints={sprints}
      />
    </QueryClientProvider>
  );
  return render(ui);
}

beforeEach(() => {
  localStorage.removeItem('trueppm.gantt.unscheduledGutter.collapsed');
  patchMock.mockClear();
  // navigator.onLine defaults true in jsdom; restore it so an offline test
  // that flips it can't bleed into the next case.
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  // The reveal-bridge test writes revealGutterSprint into the global zustand
  // store; without a reset it force-expands a collapsed tray in later tests.
  useScheduleStore.setState({ revealGutterSprint: null, scheduleActionToast: null });
});

describe('UnscheduledGutter — two-section tray', () => {
  it('partitions tasks into To Do and Backlog sections with summed header count', () => {
    renderGutter([
      makeTask({ id: 'a', name: 'Wire login', status: 'NOT_STARTED' }),
      makeTask({ id: 'b', name: 'Spike auth', status: 'BACKLOG' }),
      makeTask({ id: 'c', name: 'Idea three', status: 'BACKLOG' }),
    ]);

    // Header count is the sum across both sections.
    expect(screen.getByText('(3)')).toBeInTheDocument();

    const todoSection = screen.getByRole('group', { name: /To do, unscheduled, 1 task/i });
    expect(within(todoSection).getByText('Wire login')).toBeInTheDocument();
    expect(within(todoSection).queryByText('Spike auth')).not.toBeInTheDocument();

    const backlogSection = screen.getByRole('group', { name: /Backlog, 2 items/i });
    expect(within(backlogSection).getByText('Spike auth')).toBeInTheDocument();
    expect(within(backlogSection).getByText('Idea three')).toBeInTheDocument();
  });

  it('renders the To Do and Backlog sub-headers with their own counts', () => {
    renderGutter([
      makeTask({ id: 'a', status: 'NOT_STARTED' }),
      makeTask({ id: 'b', status: 'BACKLOG' }),
    ]);
    expect(screen.getByText('To Do · Unscheduled (1)')).toBeInTheDocument();
    expect(screen.getByText('Backlog (1)')).toBeInTheDocument();
  });

  it('keeps the Backlog section with a status empty row while To Do has items', () => {
    renderGutter([makeTask({ id: 'a', status: 'NOT_STARTED' })]);

    const backlogSection = screen.getByRole('group', { name: /Backlog, 0 items/i });
    expect(within(backlogSection).getByRole('status')).toHaveTextContent('No backlog items');
  });

  it('keeps the To Do section with a status empty row while Backlog has items', () => {
    renderGutter([makeTask({ id: 'b', status: 'BACKLOG' })]);

    const todoSection = screen.getByRole('group', { name: /To do, unscheduled, 0 tasks/i });
    expect(within(todoSection).getByRole('status')).toHaveTextContent(
      'No unscheduled To Do tasks',
    );
  });

  it('gives backlog chips a dashed left edge and a readiness label (rule 133)', () => {
    const { container } = renderGutter([
      makeTask({ id: 'b', name: 'Spike auth', status: 'BACKLOG', readiness: 'idea' }),
    ]);

    // The dashed left edge is the at-a-glance promote cue.
    const dashedRow = container.querySelector('.border-dashed');
    expect(dashedRow).not.toBeNull();
    expect(dashedRow?.className).toContain('border-l-2');

    // The readiness label is the non-color signal.
    expect(within(dashedRow as HTMLElement).getByText('idea')).toBeInTheDocument();
  });

  it('does not render a dashed edge on To Do chips', () => {
    const { container } = renderGutter([
      makeTask({ id: 'a', name: 'Wire login', status: 'NOT_STARTED' }),
    ]);
    expect(container.querySelector('.border-dashed')).toBeNull();
  });
});

describe('UnscheduledGutter — sprint-assigned backlog groups (#1790)', () => {
  it('groups sprint-assigned backlog under its target sprint with an honest header', () => {
    renderGutter(
      [makeTask({ id: 'sb', name: 'Contact dedupe', status: 'BACKLOG', sprintId: 's3', storyPoints: 5 })],
      [makeSprint({ id: 's3', name: 'Build Sprint 3', state: 'PLANNED' })],
    );

    const group = screen.getByRole('group', {
      name: /Targeted for Build Sprint 3, planned, read-only, 1 task/i,
    });
    expect(within(group).getByText('Contact dedupe')).toBeInTheDocument();
    // Honest, non-committal sub-note — never implies a committed date.
    expect(within(group).getByText('pending team plan — not scheduled')).toBeInTheDocument();
    // Story points surface the sprint-planning vocabulary.
    expect(within(group).getByText('5 pts')).toBeInTheDocument();
  });

  it('renders sprint-assigned backlog rows READ-ONLY — no actions menu, muted "planned" label', () => {
    renderGutter(
      [makeTask({ id: 'sb', name: 'Contact dedupe', status: 'BACKLOG', sprintId: 's3' })],
      [makeSprint({ id: 's3', name: 'Build Sprint 3' })],
    );

    const group = screen.getByRole('group', { name: /Targeted for Build Sprint 3/i });
    // The ··· "Actions for …" scheduling menu must not exist — dating a
    // sprint-committed item from the Schedule would violate sprint sovereignty.
    expect(within(group).queryByRole('button', { name: /Actions for/i })).toBeNull();
    expect(within(group).getByText('planned')).toBeInTheDocument();
  });

  it('keeps sprint-assigned backlog OUT of the no-sprint Backlog section', () => {
    renderGutter(
      [
        makeTask({ id: 'nb', name: 'No-sprint idea', status: 'BACKLOG', sprintId: null }),
        makeTask({ id: 'sb', name: 'Sprint idea', status: 'BACKLOG', sprintId: 's3' }),
      ],
      [makeSprint({ id: 's3', name: 'Build Sprint 3' })],
    );

    const backlogSection = screen.getByRole('group', { name: /Backlog, 1 item/i });
    expect(within(backlogSection).getByText('No-sprint idea')).toBeInTheDocument();
    expect(within(backlogSection).queryByText('Sprint idea')).not.toBeInTheDocument();
    // Header count is the sum across all sections (1 no-sprint + 1 sprint-assigned).
    expect(screen.getByText('(2)')).toBeInTheDocument();
  });

  it('labels an ACTIVE target sprint honestly (not "pending team plan")', () => {
    renderGutter(
      [makeTask({ id: 'sb', name: 'Stretch item', status: 'BACKLOG', sprintId: 's2' })],
      [makeSprint({ id: 's2', name: 'Build Sprint 2', state: 'ACTIVE' })],
    );
    const group = screen.getByRole('group', { name: /Targeted for Build Sprint 2, active, read-only/i });
    expect(within(group).getByText('not yet started — not scheduled')).toBeInTheDocument();
  });

  it('tags each sprint group with data-sprint-group for the reveal bridge (#1798)', () => {
    const { container } = renderGutter(
      [makeTask({ id: 'sb', name: 'Stretch item', status: 'BACKLOG', sprintId: 's2' })],
      [makeSprint({ id: 's2', name: 'Build Sprint 2', state: 'PLANNED' })],
    );
    expect(container.querySelector('[data-sprint-group="s2"]')).toBeTruthy();
  });
});

describe('UnscheduledGutter — reveal bridge (#1798)', () => {
  beforeEach(() => {
    useScheduleStore.setState({ revealGutterSprint: null });
  });

  it('expands the collapsed tray and scrolls the requested sprint group into view', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    // Persist a collapsed tray, then request the reveal.
    localStorage.setItem('trueppm.gantt.unscheduledGutter.collapsed', 'true');

    renderGutter(
      [makeTask({ id: 'sb', name: 'Stretch item', status: 'BACKLOG', sprintId: 's2' })],
      [makeSprint({ id: 's2', name: 'Build Sprint 2', state: 'PLANNED' })],
    );
    // Collapsed: the group is not rendered yet.
    expect(screen.queryByText('Stretch item')).toBeNull();

    useScheduleStore.getState().requestRevealGutterSprint('s2');

    // The tray expands (group renders) and the group is scrolled into view.
    expect(await screen.findByText('Stretch item')).toBeInTheDocument();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });
});

describe('UnscheduledGutter — collapse / empty header states', () => {
  it('starts collapsed with the reassurance message hidden when there are no tasks, reachable via the toggle', () => {
    renderGutter([]);
    expect(screen.getByText('(0)')).toBeInTheDocument();
    // Collapsed by default — the one-time confirmation isn't permanent chrome.
    expect(
      screen.queryByText('All To Do and Backlog tasks have planned dates'),
    ).toBeNull();
    // With an empty list the tray itself never renders — there's nothing to page.
    expect(screen.queryByText(/To Do · Unscheduled/)).toBeNull();

    const expandBtn = screen.getByRole('button', { name: 'Expand unscheduled tasks' });
    fireEvent.click(expandBtn);
    expect(
      screen.getByText('All To Do and Backlog tasks have planned dates'),
    ).toBeInTheDocument();
    expect(localStorage.getItem('trueppm.gantt.unscheduledGutter.collapsed')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse unscheduled tasks' }));
    expect(
      screen.queryByText('All To Do and Backlog tasks have planned dates'),
    ).toBeNull();
    expect(localStorage.getItem('trueppm.gantt.unscheduledGutter.collapsed')).toBe('true');
  });

  it('collapses the tray and persists the choice, then re-expands', () => {
    renderGutter([makeTask({ id: 'a', name: 'Wire login', status: 'NOT_STARTED' })]);

    // Expanded by default: the To Do sub-header is visible.
    expect(screen.getByText('To Do · Unscheduled (1)')).toBeInTheDocument();

    const collapseBtn = screen.getByRole('button', { name: 'Collapse unscheduled tasks' });
    fireEvent.click(collapseBtn);

    // The tray content is gone and the preference is persisted.
    expect(screen.queryByText('To Do · Unscheduled (1)')).toBeNull();
    expect(localStorage.getItem('trueppm.gantt.unscheduledGutter.collapsed')).toBe('true');

    // The same control now offers to expand.
    const expandBtn = screen.getByRole('button', { name: 'Expand unscheduled tasks' });
    fireEvent.click(expandBtn);
    expect(screen.getByText('To Do · Unscheduled (1)')).toBeInTheDocument();
    expect(localStorage.getItem('trueppm.gantt.unscheduledGutter.collapsed')).toBe('false');
  });

  it('starts collapsed when the persisted preference is "true"', () => {
    localStorage.setItem('trueppm.gantt.unscheduledGutter.collapsed', 'true');
    renderGutter([makeTask({ id: 'a', name: 'Wire login', status: 'NOT_STARTED' })]);

    // Tray hidden on first paint; the control invites expansion.
    expect(screen.queryByText('To Do · Unscheduled (1)')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Expand unscheduled tasks' }),
    ).toBeInTheDocument();
  });

  it('auto-expands the first time tasks appear (0 → N)', () => {
    // Persist collapsed so the initial mount with zero tasks is collapsed, then
    // rerender with a task — the count-transition effect must force it open.
    localStorage.setItem('trueppm.gantt.unscheduledGutter.collapsed', 'true');
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const canvasScrollRef = createRef<HTMLDivElement>();
    const tree = (tasks: Task[]): ReactElement => (
      <QueryClientProvider client={qc}>
        <UnscheduledGutter
          tasks={tasks}
          projectId="proj1"
          scaleData={null}
          canvasScrollRef={canvasScrollRef}
          taskListWidth={200}
        />
      </QueryClientProvider>
    );

    const { rerender } = rtlRender(tree([]));
    // Zero tasks → collapsed, no tray.
    expect(screen.queryByText(/To Do · Unscheduled/)).toBeNull();

    rerender(tree([makeTask({ id: 'a', name: 'Fresh task', status: 'NOT_STARTED' })]));
    // The 0 → 1 transition forces the tray open.
    expect(screen.getByText('To Do · Unscheduled (1)')).toBeInTheDocument();
  });
});

describe('UnscheduledGutter — set-date (menu) promote path', () => {
  it('PATCHes planned_start when a To Do row is dated via the ··· menu', async () => {
    renderGutter([makeTask({ id: 'todo-1', name: 'Wire login', status: 'NOT_STARTED' })]);

    // Open the To Do row's overflow menu (keyboard/menu alternative to drag).
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Wire login' }));

    const dateInput = await screen.findByLabelText('Set planned start');
    fireEvent.change(dateInput, { target: { value: '2026-08-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Promote to schedule' }));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock).toHaveBeenCalledWith(
      '/tasks/todo-1/',
      expect.objectContaining({ planned_start: '2026-08-01' }),
    );
  });

  it('does NOT PATCH when offline — the chip stays put (rule 29)', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    renderGutter([makeTask({ id: 'todo-2', name: 'Offline task', status: 'NOT_STARTED' })]);

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Offline task' }));
    const dateInput = await screen.findByLabelText('Set planned start');
    fireEvent.change(dateInput, { target: { value: '2026-08-02' } });
    fireEvent.click(screen.getByRole('button', { name: 'Promote to schedule' }));

    // Offline guard short-circuits before the mutation fires.
    await Promise.resolve();
    expect(patchMock).not.toHaveBeenCalled();
  });
});

describe('UnscheduledGutter — backlog Schedule… dialog (rule 135)', () => {
  it('opens the ScheduleTaskDialog from a backlog chip ··· menu and closes it', async () => {
    renderGutter([makeTask({ id: 'bk-1', name: 'Spike auth', status: 'BACKLOG' })]);

    // A backlog chip routes its ··· to the shared dialog (aria-haspopup=dialog).
    const trigger = screen.getByRole('button', { name: 'Actions for Spike auth' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /Add .*Spike auth.* to a/ })).toBeInTheDocument();

    // Cancel closes it (focus-return is the caller's contract). The dialog has
    // both a ✕ icon button and a footer button that share the "Cancel" name;
    // clicking either dismisses it.
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Cancel' })[0]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// Drag-to-promote harness
// ---------------------------------------------------------------------------

/**
 * 1 logical pixel === 1 calendar day anchored at 2026-08-01, so a pointer at
 * canvas X=5 resolves to 2026-08-06. Keeping the scale trivially linear lets
 * every drop assertion name a real date instead of a magic pixel.
 */
const SCALE: GanttScaleData = {
  start: new Date('2026-08-01T00:00:00Z'),
  end: new Date('2026-12-31T00:00:00Z'),
  totalWidth: 800,
  zoomLevel: 'week',
  pxPerMs: 1 / 86_400_000,
};

/** X=5 on the canvas → five days after the scale origin. */
const DROP_DATE = '2026-08-06';

const CANVAS_RECT: DOMRect = {
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: 800,
  bottom: 400,
  width: 800,
  height: 400,
  toJSON: () => ({}),
};

function makeCanvasRef(): RefObject<HTMLDivElement | null> {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => CANVAS_RECT;
  document.body.appendChild(el);
  return { current: el };
}

function renderDraggableGutter(
  tasks: Task[],
  { scaleData = SCALE }: { scaleData?: GanttScaleData | null } = {},
): { canvasRef: RefObject<HTMLDivElement | null> } & ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const canvasRef = makeCanvasRef();
  const utils = render(
    <QueryClientProvider client={qc}>
      <UnscheduledGutter
        tasks={tasks}
        projectId="proj1"
        scaleData={scaleData}
        canvasScrollRef={canvasRef}
        taskListWidth={200}
      />
    </QueryClientProvider>,
  );
  return { canvasRef, ...utils };
}

/** The gutter row element that owns the pointer handlers for `name`. */
function rowFor(name: string): HTMLElement {
  const label = screen.getByText(name);
  const row = label.parentElement;
  if (!row) throw new Error(`no row element for "${name}"`);
  return row;
}

/** Press on a chip and move past the 4px threshold so the drag begins. */
function beginDrag(row: HTMLElement): void {
  fireEvent.pointerDown(row, { clientX: 10, clientY: 10, button: 0, pointerId: 1 });
  fireEvent.pointerMove(row, { clientX: 40, clientY: 10, pointerId: 1 });
}

const PREVIEW_TEXT = 'Drop on timeline · Esc to cancel';

describe('UnscheduledGutter — drag onto the timeline', () => {
  beforeEach(() => {
    // jsdom implements neither pointer-capture method; the row calls both
    // unconditionally on press/threshold.
    Element.prototype.setPointerCapture = function () {};
    Element.prototype.releasePointerCapture = function () {};
  });

  it('PATCHes only planned_start when a To Do chip is dropped on the canvas', async () => {
    renderDraggableGutter([makeTask({ id: 'todo-1', name: 'Wire login', status: 'NOT_STARTED' })]);

    beginDrag(rowFor('Wire login'));
    // The floating preview tracks the pointer as soon as the drag starts.
    expect(screen.getByText(PREVIEW_TEXT)).toBeInTheDocument();

    fireEvent.pointerMove(window, { clientX: 5, clientY: 50 });
    // Over the canvas with a resolvable date → the drop guide names the day.
    const indicator = screen.getByTestId('schedule-drop-indicator');
    expect(within(indicator).getByText(formatShortDate(DROP_DATE))).toBeInTheDocument();

    fireEvent.pointerUp(window);

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    // No explicit status — the server owns the date-gated NOT_STARTED bump.
    expect(patchMock).toHaveBeenCalledWith('/tasks/todo-1/', { planned_start: DROP_DATE });
    // Preview and guide are torn down with the drag.
    expect(screen.queryByText(PREVIEW_TEXT)).toBeNull();
    expect(screen.queryByTestId('schedule-drop-indicator')).toBeNull();
  });

  it('promotes a Backlog chip with an explicit NOT_STARTED status and announces it', async () => {
    const { container } = renderDraggableGutter([
      makeTask({ id: 'bk-1', name: 'Spike auth', status: 'BACKLOG' }),
    ]);

    beginDrag(rowFor('Spike auth'));
    fireEvent.pointerMove(window, { clientX: 5, clientY: 50 });
    fireEvent.pointerUp(window);

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock).toHaveBeenCalledWith('/tasks/bk-1/', {
      planned_start: DROP_DATE,
      status: 'NOT_STARTED',
    });

    const label = formatShortDate(DROP_DATE);
    await waitFor(() =>
      expect(useScheduleStore.getState().scheduleActionToast?.message).toBe(
        `Added 'Spike auth' to the sprint, starting ${label}`,
      ),
    );
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent(
      `Added Spike auth to the sprint, starting ${label}.`,
    );
  });

  it('announces a failure (and raises no toast) when the promote PATCH rejects', async () => {
    patchMock.mockRejectedValueOnce(new Error('boom'));
    const { container } = renderDraggableGutter([
      makeTask({ id: 'bk-2', name: 'Spike auth', status: 'BACKLOG' }),
    ]);

    beginDrag(rowFor('Spike auth'));
    fireEvent.pointerMove(window, { clientX: 5, clientY: 50 });
    fireEvent.pointerUp(window);

    await waitFor(() =>
      expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent(
        'Could not add Spike auth to the sprint.',
      ),
    );
    expect(useScheduleStore.getState().scheduleActionToast).toBeNull();
  });

  it('does not PATCH when the pointer is released outside the canvas', async () => {
    renderDraggableGutter([makeTask({ id: 'todo-3', name: 'Wire login', status: 'NOT_STARTED' })]);

    beginDrag(rowFor('Wire login'));
    // 900 is past the canvas right edge (800) — no drop target, no guide.
    fireEvent.pointerMove(window, { clientX: 900, clientY: 50 });
    expect(screen.queryByTestId('schedule-drop-indicator')).toBeNull();

    fireEvent.pointerUp(window);
    await Promise.resolve();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('does not PATCH a canvas drop while offline — the chip stays put (rule 29)', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    renderDraggableGutter([makeTask({ id: 'todo-4', name: 'Wire login', status: 'NOT_STARTED' })]);

    beginDrag(rowFor('Wire login'));
    fireEvent.pointerMove(window, { clientX: 5, clientY: 50 });
    fireEvent.pointerUp(window);

    await Promise.resolve();
    expect(patchMock).not.toHaveBeenCalled();
    // The drag is still cleared so the preview does not strand on screen.
    expect(screen.queryByText(PREVIEW_TEXT)).toBeNull();
  });

  it('tracks the pointer but resolves no drop date when there is no scale data', async () => {
    renderDraggableGutter([makeTask({ id: 'todo-5', name: 'Wire login', status: 'NOT_STARTED' })], {
      scaleData: null,
    });

    beginDrag(rowFor('Wire login'));
    fireEvent.pointerMove(window, { clientX: 5, clientY: 50 });

    // Preview follows, but without a scale there is no date to guide to.
    expect(screen.getByText(PREVIEW_TEXT)).toBeInTheDocument();
    expect(screen.queryByTestId('schedule-drop-indicator')).toBeNull();

    fireEvent.pointerUp(window);
    await Promise.resolve();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('cancels the drag on Escape and ignores unrelated keys (rule 28)', () => {
    renderDraggableGutter([makeTask({ id: 'todo-6', name: 'Wire login', status: 'NOT_STARTED' })]);

    beginDrag(rowFor('Wire login'));
    fireEvent.pointerMove(window, { clientX: 5, clientY: 50 });

    // An unrelated key leaves the drag running.
    fireEvent.keyDown(window, { key: 'a' });
    expect(screen.getByText(PREVIEW_TEXT)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText(PREVIEW_TEXT)).toBeNull();
    expect(screen.queryByTestId('schedule-drop-indicator')).toBeNull();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('promotes once when a duplicate pointerup arrives in the same flush', async () => {
    renderDraggableGutter([makeTask({ id: 'todo-7', name: 'Wire login', status: 'NOT_STARTED' })]);

    beginDrag(rowFor('Wire login'));
    fireEvent.pointerMove(window, { clientX: 5, clientY: 50 });

    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup'));
      window.dispatchEvent(new PointerEvent('pointerup'));
    });

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
  });

  it('shows the promoting skeleton while the PATCH is in flight', async () => {
    patchMock.mockImplementationOnce(() => new Promise<{ data: object }>(() => {}));
    renderDraggableGutter([makeTask({ id: 'todo-8', name: 'Wire login', status: 'NOT_STARTED' })]);

    beginDrag(rowFor('Wire login'));
    fireEvent.pointerMove(window, { clientX: 5, clientY: 50 });
    fireEvent.pointerUp(window);

    expect(await screen.findByLabelText('Promoting task…')).toHaveAttribute('aria-busy', 'true');
  });
});

describe('UnscheduledGutter — sprint group edge cases', () => {
  it('falls back to a neutral header when the target sprint is not in the sprint list', () => {
    // The task references a sprint the caller did not supply (out-of-window or
    // not yet loaded): no name, no state word, no date window — and the
    // conservative "not yet started" sub-note rather than "pending team plan".
    renderGutter([makeTask({ id: 'sb', name: 'Orphan item', status: 'BACKLOG', sprintId: 'ghost' })]);

    const group = screen.getByRole('group', { name: /Targeted for Sprint/i });
    expect(within(group).getByText('Targeted: Sprint')).toBeInTheDocument();
    expect(within(group).getByText('not yet started — not scheduled')).toBeInTheDocument();
    expect(within(group).getByText('Orphan item')).toBeInTheDocument();
    // No window pill is rendered when the sprint is unknown.
    expect(within(group).queryByText(/–/)).toBeNull();
  });

  it('pluralizes the group label and lists every task in the group', () => {
    renderGutter(
      [
        makeTask({ id: 's1', name: 'Item one', status: 'BACKLOG', sprintId: 'sp' }),
        makeTask({ id: 's2', name: 'Item two', status: 'BACKLOG', sprintId: 'sp' }),
      ],
      [makeSprint({ id: 'sp', name: 'Build Sprint 4' })],
    );

    const group = screen.getByRole('group', {
      name: /Targeted for Build Sprint 4, planned, read-only, 2 tasks/i,
    });
    expect(within(group).getByText('Item one')).toBeInTheDocument();
    expect(within(group).getByText('Item two')).toBeInTheDocument();
  });

  it('orders sprint groups by start date and sinks the unknown sprint to the end', () => {
    const { container } = renderGutter(
      [
        makeTask({ id: 'c', name: 'Late item', status: 'BACKLOG', sprintId: 'late' }),
        makeTask({ id: 'a', name: 'Ghost item', status: 'BACKLOG', sprintId: 'ghost' }),
        makeTask({ id: 'b', name: 'Early item', status: 'BACKLOG', sprintId: 'early' }),
      ],
      [
        makeSprint({ id: 'late', name: 'Sprint Late', start_date: '2026-09-01' }),
        makeSprint({ id: 'early', name: 'Sprint Early', start_date: '2026-07-01' }),
      ],
    );

    const order = [...container.querySelectorAll('[data-sprint-group]')].map((el) =>
      el.getAttribute('data-sprint-group'),
    );
    expect(order).toEqual(['early', 'late', 'ghost']);
  });
});

describe('UnscheduledGutter — collapse preference read failure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to "expanded when there is work" if localStorage is unreadable', () => {
    // Safari private mode / blocked storage throws on read; the tray must still
    // render rather than crash, and non-empty work must stay visible.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    renderGutter([makeTask({ id: 'a', name: 'Wire login', status: 'NOT_STARTED' })]);
    expect(screen.getByText('To Do · Unscheduled (1)')).toBeInTheDocument();
  });
});

describe('UnscheduledGutter — reveal bridge edge cases (#1798)', () => {
  afterEach(() => {
    // Guard against a failed assertion leaking the reduced-motion stub into the
    // next file (all files share one process in singleFork mode).
    vi.unstubAllGlobals();
  });

  it('expands the tray but scrolls nothing when the reveal carries no sprint id', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    localStorage.setItem('trueppm.gantt.unscheduledGutter.collapsed', 'true');

    renderGutter([makeTask({ id: 'a', name: 'Wire login', status: 'NOT_STARTED' })]);
    expect(screen.queryByText('To Do · Unscheduled (1)')).toBeNull();

    act(() => {
      useScheduleStore.getState().requestRevealGutterSprint(null);
    });

    expect(await screen.findByText('To Do · Unscheduled (1)')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('scrolls without animation when the viewer prefers reduced motion', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: /prefers-reduced-motion/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));

    renderGutter(
      [makeTask({ id: 'sb', name: 'Stretch item', status: 'BACKLOG', sprintId: 's2' })],
      [makeSprint({ id: 's2', name: 'Build Sprint 2' })],
    );

    act(() => {
      useScheduleStore.getState().requestRevealGutterSprint('s2');
    });

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' });
  });

  it('cancels the pending reveal frames when the gutter unmounts first', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const { unmount } = renderGutter(
      [makeTask({ id: 'sb', name: 'Stretch item', status: 'BACKLOG', sprintId: 's2' })],
      [makeSprint({ id: 's2', name: 'Build Sprint 2' })],
    );

    act(() => {
      useScheduleStore.getState().requestRevealGutterSprint('s2');
    });
    unmount();

    await new Promise((r) => setTimeout(r, 60));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
