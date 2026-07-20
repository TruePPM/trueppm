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
import { screen, within, waitFor, fireEvent, render as rtlRender } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRef, type ReactElement } from 'react';
import type { ApiSprint, Task } from '@/types';
import { UnscheduledGutter } from './UnscheduledGutter';
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
  it('renders the empty header note and no collapse control when there are no tasks', () => {
    renderGutter([]);
    expect(screen.getByText('(0)')).toBeInTheDocument();
    expect(
      screen.getByText('All To Do and Backlog tasks have planned dates'),
    ).toBeInTheDocument();
    // The collapse/expand button is gated on totalCount > 0.
    expect(screen.queryByRole('button', { name: /unscheduled tasks/i })).toBeNull();
    // And with an empty list the tray itself is not rendered.
    expect(screen.queryByText(/To Do · Unscheduled/)).toBeNull();
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
