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
import { formatShortDate, todayLocalIso } from './scheduleUtils';
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

function renderGutter(
  tasks: Task[],
  sprints?: ApiSprint[],
  onScheduleMany?: (ids: string[]) => void,
  onWalkToUnscheduled?: () => void,
): ReturnType<typeof render> {
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
        onScheduleMany={onScheduleMany}
        onWalkToUnscheduled={onWalkToUnscheduled}
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

/**
 * #3131 — the header count is a control that walks you to the rows it counts,
 * not a caption that describes them.
 */
describe('UnscheduledGutter — the count is a control', () => {
  const rows = [
    makeTask({ id: 'a', name: 'Wire login', status: 'NOT_STARTED' }),
    makeTask({ id: 'b', name: 'Draft spec', status: 'BACKLOG' }),
  ];

  it('renders the count as a button that walks the outline when a handler is given', () => {
    const onWalk = vi.fn();
    renderGutter(rows, undefined, undefined, onWalk);

    const countBtn = screen.getByRole('button', {
      name: /Go to the next unscheduled item in the outline/i,
    });
    // The visible affordance is still the count itself.
    expect(within(countBtn).getByText('(2)')).toBeInTheDocument();
    // The accessible name carries the number too — the arrow is decorative.
    expect(countBtn).toHaveAccessibleName(/2 items unscheduled/i);

    fireEvent.click(countBtn);
    expect(onWalk).toHaveBeenCalledTimes(1);
  });

  it('is a repeatable walk — a second click asks for the next row, not the same one', () => {
    const onWalk = vi.fn();
    renderGutter(rows, undefined, undefined, onWalk);

    const countBtn = screen.getByRole('button', {
      name: /Go to the next unscheduled item in the outline/i,
    });
    fireEvent.click(countBtn);
    fireEvent.click(countBtn);
    expect(onWalk).toHaveBeenCalledTimes(2);
  });

  /**
   * Rule 302: a control with nothing behind it is absent, not inert. With no
   * handler the count falls back to the plain span it has always been — never
   * a `disabled` button, which would announce "[label], dimmed" to a screen
   * reader and teach the reader the product is broken.
   */
  it('falls back to a plain count — never a disabled button — with no handler', () => {
    renderGutter(rows);

    expect(
      screen.queryByRole('button', { name: /Go to the next unscheduled item/i }),
    ).toBeNull();
    expect(screen.getByText('(2)')).toBeInTheDocument();
    // Nothing in the header strip is a disabled control.
    for (const btn of screen.getAllByRole('button')) {
      expect(btn).not.toBeDisabled();
    }
  });

  /**
   * The walk and the bulk-edit sheet are two different acts on the same tray,
   * and both must remain reachable. "Schedule N…" writes dates in a batch; the
   * count only moves focus.
   */
  it('coexists with the Schedule N… button rather than replacing it', () => {
    const onWalk = vi.fn();
    const onScheduleMany = vi.fn();
    renderGutter(rows, undefined, onScheduleMany, onWalk);

    expect(
      screen.getByRole('button', { name: /Go to the next unscheduled item/i }),
    ).toBeInTheDocument();
    const scheduleBtn = screen.getByRole('button', { name: /^Schedule 2/i });
    expect(scheduleBtn).toBeInTheDocument();

    fireEvent.click(scheduleBtn);
    expect(onScheduleMany).toHaveBeenCalledTimes(1);
    expect(onWalk).not.toHaveBeenCalled();
  });

  it('does not offer the walk when there is nothing to walk to', () => {
    renderGutter([], undefined, undefined, vi.fn());
    expect(
      screen.queryByRole('button', { name: /Go to the next unscheduled item/i }),
    ).toBeNull();
  });

  /**
   * WCAG 2.5.3 Label in Name — the visible label is `(2)`, so the accessible
   * name has to contain it or a speech-input user saying "click 2" gets
   * nothing. It leads with the token rather than merely including it.
   */
  it('leads the accessible name with the visible count', () => {
    renderGutter(rows, undefined, undefined, vi.fn());
    const countBtn = screen.getByRole('button', {
      name: /Go to the next unscheduled item/i,
    });
    expect(countBtn).toHaveAccessibleName(/^\(2\)/);
  });
});

/**
 * #3131 — the tray disappearing at zero must not take the user's focus or an
 * in-flight signal down with it. Both of these are the same class as the
 * aria-live region being hoisted out of the render gate.
 */
describe('UnscheduledGutter — what survives the tray vanishing', () => {
  function renderWithCount(tasks: Task[], qc: QueryClient) {
    return (
      <QueryClientProvider client={qc}>
        <UnscheduledGutter
          tasks={tasks}
          projectId="proj1"
          scaleData={null}
          canvasScrollRef={createRef<HTMLDivElement>()}
          taskListWidth={200}
          onWalkToUnscheduled={vi.fn()}
        />
      </QueryClientProvider>
    );
  }

  it('hands focus back to the outline when the region unmounts under it', () => {
    // Stand in for the Schedule outline's roving-tabindex row.
    const outlineRow = document.createElement('div');
    outlineRow.setAttribute('data-row-id', 'outline-anchor');
    outlineRow.setAttribute('tabindex', '0');
    document.body.appendChild(outlineRow);

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const task = makeTask({ id: 'a', name: 'Wire login', status: 'NOT_STARTED' });
    const { rerender } = rtlRender(renderWithCount([task], qc));

    // Focus rests on a control inside the tray.
    const walkBtn = screen.getByRole('button', {
      name: /Go to the next unscheduled item/i,
    });
    act(() => walkBtn.focus());
    expect(document.activeElement).toBe(walkBtn);

    // The last unscheduled row gets a date somewhere else — the tray empties.
    rerender(renderWithCount([], qc));

    expect(screen.queryByRole('region', { name: 'Unscheduled tasks' })).toBeNull();
    expect(document.activeElement).toBe(outlineRow);

    outlineRow.remove();
  });

  it('leaves focus alone when it was never inside the tray', () => {
    const outsideBtn = document.createElement('button');
    document.body.appendChild(outsideBtn);
    const outlineRow = document.createElement('div');
    outlineRow.setAttribute('data-row-id', 'outline-anchor');
    outlineRow.setAttribute('tabindex', '0');
    document.body.appendChild(outlineRow);

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const task = makeTask({ id: 'a', name: 'Wire login', status: 'NOT_STARTED' });
    const { rerender } = rtlRender(renderWithCount([task], qc));

    act(() => outsideBtn.focus());
    rerender(renderWithCount([], qc));

    // The tray had no claim on focus, so it must not seize it on the way out.
    expect(document.activeElement).toBe(outsideBtn);

    outsideBtn.remove();
    outlineRow.remove();
  });
});

describe('UnscheduledGutter — collapse / empty header states', () => {
  /**
   * #3131 — this case is the inverse of the one it replaces. It used to assert
   * that an empty tray still rendered a header, a `(0)` and a reassurance
   * caption reachable through the collapse toggle. An empty queue is not a
   * status: absence is the empty state now, matching the mobile tray.
   */
  it('renders nothing at all when there is nothing unscheduled', () => {
    renderGutter([]);
    expect(screen.queryByRole('region', { name: 'Unscheduled tasks' })).toBeNull();
    expect(screen.queryByText('(0)')).toBeNull();
    expect(screen.queryByText(/^Unscheduled$/)).toBeNull();
    // The caption this issue deleted must not come back by another route.
    expect(
      screen.queryByText('All To Do and Backlog tasks have planned dates'),
    ).toBeNull();
    // No toggle either — there is nothing behind it to disclose.
    expect(screen.queryByRole('button', { name: /unscheduled tasks$/i })).toBeNull();
    expect(screen.queryByText(/To Do · Unscheduled/)).toBeNull();
  });

  /**
   * The gate lives inside the component rather than at its call site precisely
   * so this node survives the count reaching zero. `usePromoteTask` is
   * optimistic, so the last row leaves the tray BEFORE its `onSuccess` writes
   * the "scheduled" announcement into this ref (#3064) — unmounting the whole
   * component on that transition would silently eat it.
   *
   * Asserted on the container rather than by role: an empty `aria-live` region
   * exposes no accessible name to query by, and its whole job is to be present
   * and empty until something is written into it.
   */
  it('keeps the aria-live region mounted at zero so the last promote can still announce', () => {
    const { container } = renderGutter([]);
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live).toHaveClass('sr-only');
  });

  it('appears as soon as the tray holds something, expanded', () => {
    const { rerender } = renderGutter([]);
    expect(screen.queryByRole('region', { name: 'Unscheduled tasks' })).toBeNull();

    // Re-render the same mounted component with one unscheduled row, which is
    // what a task losing its planned start does.
    rerender(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
          })
        }
      >
        <UnscheduledGutter
          tasks={[makeTask({ id: 'a', name: 'Wire login', status: 'NOT_STARTED' })]}
          projectId="proj1"
          scaleData={null}
          canvasScrollRef={createRef<HTMLDivElement>()}
          taskListWidth={200}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole('region', { name: 'Unscheduled tasks' })).toBeInTheDocument();
    expect(screen.getByText('(1)')).toBeInTheDocument();
    // Auto-expand on first appearance — a row that just fell out of the plan
    // must not hide behind a chevron.
    expect(screen.getByText('To Do · Unscheduled (1)')).toBeInTheDocument();
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

    const dateInput = await screen.findByLabelText('Or pick a date');
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
    const dateInput = await screen.findByLabelText('Or pick a date');
    fireEvent.change(dateInput, { target: { value: '2026-08-02' } });
    fireEvent.click(screen.getByRole('button', { name: 'Promote to schedule' }));

    // Offline guard short-circuits before the mutation fires.
    await Promise.resolve();
    expect(patchMock).not.toHaveBeenCalled();
  });
});

describe('UnscheduledGutter — one-click quick actions (#3064)', () => {
  // The menu's labels and its collapse rule are both functions of "today", so
  // pin the clock. The expected strings are DERIVED from the pinned instant via
  // the same local-date helper the component uses — hardcoding "Aug 26" would
  // pass in one timezone and fail in another, which is the bug this helper
  // exists to prevent.
  beforeEach(() => {
    // `shouldAdvanceTime` is required, not incidental: a plain fake clock stops
    // Testing Library's findBy* polling dead, and every assertion here times out
    // at 5s rather than failing on its own merits.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-08-26T12:00:00Z'));
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });
  afterEach(() => vi.useRealTimers());

  it('offers both answers, each naming its own date, when they differ', async () => {
    // A predecessor pushes CPM's earliest past today: the two commits are
    // genuinely different dates and the planner has to be able to tell which.
    renderGutter([
      makeTask({ id: 'q1', name: 'Blocked work', status: 'NOT_STARTED', start: '2026-09-07' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Blocked work' }));

    expect(
      await screen.findByRole('menuitem', {
        name: `Start at the earliest (${formatShortDate('2026-09-07')})`,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: `Start today (${formatShortDate(todayLocalIso())})` }),
    ).toBeInTheDocument();
  });

  it('collapses to one item when the earliest IS today', async () => {
    // Two entries with identical outcomes is a choice the user cannot make
    // wrong, which is worse than no choice at all.
    renderGutter([
      makeTask({ id: 'q2', name: 'Ready now', status: 'NOT_STARTED', start: todayLocalIso() }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Ready now' }));

    await screen.findByRole('menuitem', { name: /Start at the earliest/ });
    expect(screen.queryByRole('menuitem', { name: /Start today/ })).not.toBeInTheDocument();
  });

  it('offers only "Start today" when CPM has produced no start', async () => {
    renderGutter([makeTask({ id: 'q3', name: 'No dates', status: 'NOT_STARTED', start: '' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for No dates' }));

    expect(await screen.findByRole('menuitem', { name: /Start today/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Start at the earliest/ })).not.toBeInTheDocument();
  });

  it('commits the CPM start in one click, with no date entry', async () => {
    renderGutter([
      makeTask({ id: 'q4', name: 'One click', status: 'NOT_STARTED', start: '2026-09-07' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for One click' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Start at the earliest/ }));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock).toHaveBeenCalledWith(
      '/tasks/q4/',
      expect.objectContaining({ planned_start: '2026-09-07' }),
    );
  });

  it('"Start today" commits today even when the earliest is later', async () => {
    // Deliberately NOT suppressed: the resulting gap between the committed and
    // the computed start is a real schedule conflict, and the menu's job is to
    // let the planner express it, not to quietly prevent them.
    renderGutter([
      makeTask({ id: 'q5', name: 'Push it', status: 'NOT_STARTED', start: '2026-09-07' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Push it' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Start today/ }));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock).toHaveBeenCalledWith(
      '/tasks/q5/',
      expect.objectContaining({ planned_start: todayLocalIso() }),
    );
  });

  it('sends only planned_start — the status transition stays the server\'s call (#336)', async () => {
    renderGutter([
      makeTask({ id: 'q6', name: 'Wire shape', status: 'NOT_STARTED', start: '2026-09-07' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Wire shape' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Start at the earliest/ }));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    // Exact object, not objectContaining — the point is that nothing ELSE is on
    // the wire, which objectContaining could never prove.
    expect(patchMock).toHaveBeenCalledWith('/tasks/q6/', { planned_start: '2026-09-07' });
  });

  it('seeds the picker with the CPM start so the submit is live on open', async () => {
    renderGutter([
      makeTask({ id: 'q7', name: 'Seeded', status: 'NOT_STARTED', start: '2026-09-07' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Seeded' }));

    expect(await screen.findByLabelText('Or pick a date')).toHaveValue('2026-09-07');
    expect(screen.getByRole('button', { name: 'Promote to schedule' })).toBeEnabled();
  });

  it('falls back to today when there is no CPM start to seed from', async () => {
    renderGutter([makeTask({ id: 'q8', name: 'Undated', status: 'NOT_STARTED', start: '' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Undated' }));

    expect(await screen.findByLabelText('Or pick a date')).toHaveValue(todayLocalIso());
  });

  it('announces the commit — the chip leaving the tray is silent to a screen reader', async () => {
    const { container } = renderGutter([
      makeTask({ id: 'q11', name: 'Announce me', status: 'NOT_STARTED', start: '2026-09-07' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Announce me' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Start at the earliest/ }));

    await waitFor(() =>
      expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent(
        `Scheduled Announce me to start ${formatShortDate('2026-09-07')}.`,
      ),
    );
  });

  it('focuses the first quick action on open, not the picker below it', async () => {
    renderGutter([
      makeTask({ id: 'k1', name: 'Keyboard first', status: 'NOT_STARTED', start: '2026-09-07' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Keyboard first' }));

    const first = await screen.findByRole('menuitem', { name: /Start at the earliest/ });
    await waitFor(() => expect(document.activeElement).toBe(first));
  });

  it('moves between quick actions with Arrow keys, and wraps', async () => {
    renderGutter([
      makeTask({ id: 'k3', name: 'Arrow me', status: 'NOT_STARTED', start: '2026-09-07' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Arrow me' }));

    const earliest = await screen.findByRole('menuitem', { name: /Start at the earliest/ });
    const today = screen.getByRole('menuitem', { name: /Start today/ });
    await waitFor(() => expect(document.activeElement).toBe(earliest));

    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(today);
    // Wraps rather than dead-ending at the last item.
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(earliest);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(today);
  });

  it('offers no quick actions on a backlog chip — that path owns its own dialog', () => {
    renderGutter([
      makeTask({ id: 'q9', name: 'Spike', status: 'BACKLOG', start: '2026-09-07' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Spike' }));

    expect(screen.queryByRole('menuitem', { name: /Start at the earliest/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Start today/ })).not.toBeInTheDocument();
  });

  it('refuses the quick commit offline, like every other schedule write (rule 29)', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    renderGutter([
      makeTask({ id: 'q10', name: 'Offline quick', status: 'NOT_STARTED', start: '2026-09-07' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Offline quick' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Start at the earliest/ }));

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

describe('UnscheduledGutter — bulk "Schedule N…" button (#2987)', () => {
  it('is absent when the viewer cannot edit — apparatus omitted, not disabled', () => {
    renderGutter([makeTask({ id: 'a', status: 'NOT_STARTED' })]);
    expect(screen.queryByRole('button', { name: /^Schedule \d/ })).not.toBeInTheDocument();
  });

  it('is absent when every unscheduled row is sprint-targeted', () => {
    const onScheduleMany = vi.fn();
    renderGutter(
      [makeTask({ id: 'a', status: 'BACKLOG', sprintId: 's1' })],
      [makeSprint({ id: 's1' })],
      onScheduleMany,
    );
    expect(screen.queryByRole('button', { name: /^Schedule \d/ })).not.toBeInTheDocument();
  });

  it('hands up exactly the To Do and Backlog row ids, excluding sprint-targeted rows', () => {
    const onScheduleMany = vi.fn();
    renderGutter(
      [
        makeTask({ id: 'a', status: 'NOT_STARTED' }),
        makeTask({ id: 'b', status: 'BACKLOG' }),
        makeTask({ id: 'c', status: 'BACKLOG', sprintId: 's1' }),
      ],
      [makeSprint({ id: 's1' })],
      onScheduleMany,
    );

    fireEvent.click(screen.getByRole('button', { name: /Schedule 2 unscheduled tasks/i }));
    expect(onScheduleMany).toHaveBeenCalledWith(['a', 'b']);
  });

  it('counts only what it can act on, while the header keeps the total', () => {
    renderGutter(
      [
        makeTask({ id: 'a', status: 'NOT_STARTED' }),
        makeTask({ id: 'c', status: 'BACKLOG', sprintId: 's1' }),
      ],
      [makeSprint({ id: 's1' })],
      vi.fn(),
    );

    // Header total is 2; the button acts on 1.
    expect(screen.getByText('(2)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Schedule 1 unscheduled task/ })).toBeInTheDocument();
  });

  it('explains the excluded rows to a screen reader when the counts differ', () => {
    renderGutter(
      [
        makeTask({ id: 'a', status: 'NOT_STARTED' }),
        makeTask({ id: 'c', status: 'BACKLOG', sprintId: 's1' }),
        makeTask({ id: 'd', status: 'BACKLOG', sprintId: 's1' }),
      ],
      [makeSprint({ id: 's1' })],
      vi.fn(),
    );

    expect(
      screen.getByRole('button', {
        name: 'Schedule 1 unscheduled task — 2 sprint-targeted items are excluded',
      }),
    ).toBeInTheDocument();
  });

  it('leaves the visible label as the accessible name when nothing is excluded', () => {
    renderGutter(
      [
        makeTask({ id: 'a', status: 'NOT_STARTED' }),
        makeTask({ id: 'b', status: 'BACKLOG' }),
      ],
      undefined,
      vi.fn(),
    );
    expect(screen.getByRole('button', { name: 'Schedule 2…' })).toBeInTheDocument();
  });

  it('stays reachable while the tray is collapsed — the count and its answer travel together', () => {
    const onScheduleMany = vi.fn();
    renderGutter([makeTask({ id: 'a', status: 'NOT_STARTED' })], undefined, onScheduleMany);

    fireEvent.click(screen.getByRole('button', { name: /Collapse unscheduled tasks/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Schedule 1/ }));
    expect(onScheduleMany).toHaveBeenCalledWith(['a']);
  });
});

describe('UnscheduledGutter — offline guard on bulk schedule (#2987, rule 29)', () => {
  it('refuses to open the sheet offline and says why, rather than failing at Apply', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const onScheduleMany = vi.fn();
    renderGutter([makeTask({ id: 'a', status: 'NOT_STARTED' })], undefined, onScheduleMany);

    fireEvent.click(screen.getByRole('button', { name: /^Schedule 1/ }));

    expect(onScheduleMany).not.toHaveBeenCalled();
    expect(useScheduleStore.getState().scheduleActionToast?.message).toMatch(/offline/i);
  });

  it('opens normally once back online', () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    const onScheduleMany = vi.fn();
    renderGutter([makeTask({ id: 'a', status: 'NOT_STARTED' })], undefined, onScheduleMany);

    fireEvent.click(screen.getByRole('button', { name: /^Schedule 1/ }));
    expect(onScheduleMany).toHaveBeenCalledWith(['a']);
  });
});
