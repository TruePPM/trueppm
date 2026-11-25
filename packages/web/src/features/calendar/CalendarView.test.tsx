import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithRouter, renderWithProvidersAndRouter } from '@/test/utils';
import { ROLE_VIEWER, ROLE_MEMBER } from '@/lib/roles';
import type { Task } from '@/types';
import { CalendarView } from './CalendarView';

const calendarTasksMock = vi.hoisted(() => vi.fn());
const roleMock = vi.hoisted(() => vi.fn());
const projectMock = vi.hoisted(() => vi.fn());

// The methodology action is withheld from a non-admin; these specs assert it, so they run as one.
vi.mock('@/hooks/useAdminSettingsAccess', () => ({
  useAdminSettingsAccess: () => ({ verdict: 'admin', refetch: () => {} }),
}));
vi.mock('@/hooks/useCalendarTasks', () => ({ useCalendarTasks: calendarTasksMock }));
vi.mock('@/hooks/useCurrentUserRole', () => ({ useCurrentUserRole: roleMock }));
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));
const sprintsState = vi.hoisted(() => ({ sprints: [] as unknown[] }));
vi.mock('@/hooks/useSprints', () => ({ useSprints: () => ({ sprints: sprintsState.sprints }) }));
const myResourceState = vi.hoisted(() => ({
  resourceId: 'r-me' as string | null,
  isLoading: false,
}));
vi.mock('@/hooks/useCurrentUserResourceId', () => ({
  useCurrentUserResourceId: () => myResourceState,
}));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => 'lg' }));
// Server-resolved methodology (#2619) — drives the explanatory empty state.
// Default (no data) lets the component's own `?? 'HYBRID'` fallback apply.
vi.mock('@/hooks/useProject', () => ({ useProject: projectMock }));
const workingTimeSpy = vi.hoisted(() => vi.fn());
const workingTimeState = vi.hoisted(() => ({ layoutSettling: false, incomplete: false }));
vi.mock('./useCalendarWorkingTime', async () => {
  const { deriveWeekStartDay } =
    await vi.importActual<typeof import('./calendarUtils')>('./calendarUtils');
  return {
    useCalendarWorkingTime: (args: { effectiveCalendar?: { working_days: number } }) => {
      workingTimeSpy(args);
      return {
        workingTime: { mask: 31, calendars: [], previewByDate: new Map(), exceptions: [] },
        weekStartDay: deriveWeekStartDay(args.effectiveCalendar?.working_days),
        layoutSettling: workingTimeState.layoutSettling,
        workingTimeIncomplete: workingTimeState.incomplete,
      };
    },
  };
});

vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: () => ({
    singular: 'Sprint',
    plural: 'Sprints',
    lower: 'sprint',
    lowerPlural: 'sprints',
    possessive: "Sprint's",
  }),
}));
// Mutable so a case can drive the view mode (#3167); reset in beforeEach.
const calFilterMock = vi.hoisted(() => ({
  state: {
    calView: 'month' as 'month' | 'week',
    anchorIso: '2026-05-01',
    groupByAssignee: false,
    mineOnly: false,
  },
  setMineOnly: undefined as unknown as ReturnType<typeof vi.fn>,
  setGroupByAssignee: undefined as unknown as ReturnType<typeof vi.fn>,
  setCalView: undefined as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock('./useCalendarFilter', () => ({
  useCalendarFilter: () => ({
    calView: calFilterMock.state.calView,
    anchorIso: calFilterMock.state.anchorIso,
    setCalView: calFilterMock.setCalView,
    groupByAssignee: calFilterMock.state.groupByAssignee,
    setGroupByAssignee: calFilterMock.setGroupByAssignee,
    mineOnly: calFilterMock.state.mineOnly,
    setMineOnly: calFilterMock.setMineOnly,
    goToToday: vi.fn(),
    goNext: vi.fn(),
    goPrev: vi.fn(),
  }),
}));
// Stub the heavy grid + modal — this suite exercises CalendarView's state
// branching, not their internals.
vi.mock('./CalendarGrid', () => ({
  CalendarGrid: ({
    calView,
    workingTimeIncomplete,
    groupByAssignee,
    tasks,
  }: {
    calView?: string;
    workingTimeIncomplete?: boolean;
    groupByAssignee?: boolean;
    tasks?: Array<{ id: string }>;
  }) => (
    <div
      data-testid="calendar-grid"
      data-cal-view={calView}
      data-incomplete={String(workingTimeIncomplete)}
      data-group={String(groupByAssignee)}
      data-task-ids={tasks?.map((t) => t.id).join(',')}
    />
  ),
}));
vi.mock('@/features/board/TaskFormModal', () => ({
  TaskFormModal: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="New task">
      <button type="button" onClick={onClose}>
        close-modal
      </button>
    </div>
  ),
}));

const sampleTask: Task = {
  id: 't1',
  wbs: '1',
  name: 'Task 1',
  start: '2026-05-05',
  finish: '2026-05-08',
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
};

const refetch = vi.fn();

beforeEach(() => {
  calendarTasksMock.mockReturnValue({ tasks: [], isLoading: false, error: null, refetch });
  roleMock.mockReturnValue({ role: ROLE_MEMBER, roleLabel: null, isLoading: false });
  projectMock.mockReturnValue({ data: undefined, isLoading: false, error: null });
  calFilterMock.state = {
    calView: 'month',
    anchorIso: '2026-05-01',
    groupByAssignee: false,
    mineOnly: false,
  };
  calFilterMock.setMineOnly = vi.fn();
  calFilterMock.setGroupByAssignee = vi.fn();
  calFilterMock.setCalView = vi.fn();
  sprintsState.sprints = [];
  myResourceState.resourceId = 'r-me';
  myResourceState.isLoading = false;
  workingTimeState.layoutSettling = false;
  workingTimeState.incomplete = false;
});
afterEach(() => vi.clearAllMocks());

describe('CalendarView fetch window (#3244)', () => {
  it('requests only the visible month grid, adjacent-month days included', () => {
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    // May 2026 with a Monday week start: the first row begins Mon Apr 27.
    expect(calendarTasksMock).toHaveBeenCalledWith({
      startGte: '2026-04-27',
      finishLte: '2026-05-31',
    });
  });

  it('narrows the request to the anchored week in week view', () => {
    calFilterMock.state = { ...calFilterMock.state, calView: 'week', anchorIso: '2026-05-06' };
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(calendarTasksMock).toHaveBeenCalledWith({
      startGte: '2026-05-04',
      finishLte: '2026-05-10',
    });
  });
});

describe('CalendarView state branches (#2161)', () => {
  it('shows a busy skeleton while loading — never the empty copy', () => {
    calendarTasksMock.mockReturnValue({ tasks: [], isLoading: true, error: null, refetch });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.getByRole('status', { name: 'Loading calendar' })).toBeInTheDocument();
    expect(screen.queryByText(/No tasks yet/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('calendar-grid')).not.toBeInTheDocument();
  });

  it('shows a retry-able error state on fetch failure — never the empty copy', async () => {
    calendarTasksMock.mockReturnValue({
      tasks: [],
      isLoading: false,
      error: new Error('boom'),
      refetch,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load the calendar.");
    expect(screen.queryByText(/No tasks yet/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('shows the empty state with a create CTA for a Member+', () => {
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add task' })).toBeInTheDocument();
  });

  it('omits the create CTA for a Viewer', () => {
    roleMock.mockReturnValue({ role: ROLE_VIEWER, roleLabel: null, isLoading: false });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add task' })).not.toBeInTheDocument();
  });

  it('opens the task-create modal from the empty-state CTA', async () => {
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    await userEvent.click(screen.getByRole('button', { name: '+ Add task' }));
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeInTheDocument();
  });

  it('renders the grid when tasks are present', () => {
    calendarTasksMock.mockReturnValue({
      tasks: [sampleTask],
      isLoading: false,
      error: null,
      refetch,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.getByTestId('calendar-grid')).toBeInTheDocument();
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
  });

  // #2619: AGILE hides this route's nav entry, but it stays reachable by direct
  // URL — the bug was the cold-start CTA never saying so.
  it('shows the methodology-mismatch empty state on an AGILE project', () => {
    projectMock.mockReturnValue({
      data: { effective_methodology: 'AGILE' },
      isLoading: false,
      error: null,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.getByText("Calendar isn't part of this project's workflow")).toBeInTheDocument();
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to Sprints' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change methodology' })).toBeInTheDocument();
  });

  // #2619 finding A: the empty state above was the ONLY mismatch signal, so a
  // populated calendar on an AGILE project said nothing at all. Both polarities
  // live together here on purpose — a "make these consistent" refactor has to
  // confront the pair.
  it('warns on a POPULATED calendar under AGILE, and still renders the grid', () => {
    projectMock.mockReturnValue({
      data: { effective_methodology: 'AGILE' },
      isLoading: false,
      error: null,
    });
    calendarTasksMock.mockReturnValue({
      tasks: [sampleTask],
      isLoading: false,
      error: null,
      refetch,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(
      screen.getByText(/This project is configured as Agile, but it already has a schedule/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review methodology' })).toBeInTheDocument();
    // The work itself is never hidden — the route stays reachable by design.
    expect(screen.getByTestId('calendar-grid')).toBeInTheDocument();
    // Disjointness: the banner and the empty state never co-occur.
    expect(
      screen.queryByText("Calendar isn't part of this project's workflow"),
    ).not.toBeInTheDocument();
  });

  it('shows no banner on a populated calendar under HYBRID', () => {
    projectMock.mockReturnValue({
      data: { effective_methodology: 'HYBRID' },
      isLoading: false,
      error: null,
    });
    calendarTasksMock.mockReturnValue({
      tasks: [sampleTask],
      isLoading: false,
      error: null,
      refetch,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.queryByRole('button', { name: 'Review methodology' })).not.toBeInTheDocument();
  });

  it("shows no banner on an EMPTY calendar under AGILE — that is the empty state's job", () => {
    projectMock.mockReturnValue({
      data: { effective_methodology: 'AGILE' },
      isLoading: false,
      error: null,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.getByText("Calendar isn't part of this project's workflow")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review methodology' })).not.toBeInTheDocument();
  });

  // Rule 392: `tasks: []` while the query is in flight or after it failed is
  // "unknown", never "this project has no schedule to warn about". The banner
  // sits outside the ternary that owns those states, so it needs its own guard —
  // and this pair is what proves the guard is there.
  it('shows no banner while the task query is in flight under AGILE', () => {
    projectMock.mockReturnValue({
      data: { effective_methodology: 'AGILE' },
      isLoading: false,
      error: null,
    });
    calendarTasksMock.mockReturnValue({ tasks: [], isLoading: true, error: null, refetch });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.queryByRole('button', { name: 'Review methodology' })).not.toBeInTheDocument();
  });

  it('shows no banner after the task query failed under AGILE', () => {
    projectMock.mockReturnValue({
      data: { effective_methodology: 'AGILE' },
      isLoading: false,
      error: null,
    });
    calendarTasksMock.mockReturnValue({
      tasks: [],
      isLoading: false,
      error: new Error('boom'),
      refetch,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.queryByRole('button', { name: 'Review methodology' })).not.toBeInTheDocument();
  });

  it('keeps the generic empty state on a non-AGILE project', () => {
    projectMock.mockReturnValue({
      data: { effective_methodology: 'HYBRID' },
      isLoading: false,
      error: null,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    expect(
      screen.queryByText("Calendar isn't part of this project's workflow"),
    ).not.toBeInTheDocument();
  });
});

describe('CalendarView week mode (#3167)', () => {
  it('heads the toolbar with the month name in month mode', () => {
    calendarTasksMock.mockReturnValue({
      tasks: [sampleTask],
      isLoading: false,
      error: null,
      refetch,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.getByRole('heading', { level: 2, name: 'May 2026' })).toBeInTheDocument();
  });

  it('heads the toolbar with the week range in week mode', () => {
    calFilterMock.state = { ...calFilterMock.state, calView: 'week', anchorIso: '2026-05-01' };
    calendarTasksMock.mockReturnValue({
      tasks: [sampleTask],
      isLoading: false,
      error: null,
      refetch,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(
      screen.getByRole('heading', { level: 2, name: 'Apr 27 \u2013 May 3, 2026' }),
    ).toBeInTheDocument();
  });

  it('threads calView down to the grid — the defect was that it did not', () => {
    calFilterMock.state = { ...calFilterMock.state, calView: 'week', anchorIso: '2026-05-01' };
    calendarTasksMock.mockReturnValue({
      tasks: [sampleTask],
      isLoading: false,
      error: null,
      refetch,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    expect(screen.getByTestId('calendar-grid')).toHaveAttribute('data-cal-view', 'week');
  });

  it('mounts the live region empty — no announcement on first paint', () => {
    calendarTasksMock.mockReturnValue({
      tasks: [sampleTask],
      isLoading: false,
      error: null,
      refetch,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    // Present in the a11y tree from the start (so a later write is a mutation of
    // an existing node), but silent until the user actually changes something.
    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('');
  });

  it('announces the window after a mode change', async () => {
    calendarTasksMock.mockReturnValue({
      tasks: [sampleTask],
      isLoading: false,
      error: null,
      refetch,
    });
    // renderWithRouter bakes the element into createMemoryRouter, so its
    // rerender does not reach the component (see src/test/utils.tsx). This case
    // needs a real rerender to fire the effect, so it uses the MemoryRouter form.
    const { rerender } = renderWithProvidersAndRouter(<CalendarView />, {
      initialEntries: ['/projects/proj-1?view=calendar'],
    });
    calFilterMock.state = { ...calFilterMock.state, calView: 'week', anchorIso: '2026-05-01' };
    rerender(<CalendarView />);
    // sampleTask spans May 5-8, which is outside the Apr 27 - May 3 week, so
    // the emptiness of the window is folded into the same announcement rather
    // than left to a second live region (web rule 354).
    expect(
      await screen.findByText('Week view, Apr 27 \u2013 May 3, 2026, no tasks'),
    ).toBeInTheDocument();
  });

  it('announces without the no-tasks suffix when the window has work in it', async () => {
    // A task inside the Apr 27 - May 3 week.
    const inWeek: Task = {
      ...sampleTask,
      id: 'in-week',
      start: '2026-04-29',
      finish: '2026-04-30',
    };
    calendarTasksMock.mockReturnValue({ tasks: [inWeek], isLoading: false, error: null, refetch });
    const { rerender } = renderWithProvidersAndRouter(<CalendarView />, {
      initialEntries: ['/projects/proj-1?view=calendar'],
    });
    calFilterMock.state = { ...calFilterMock.state, calView: 'week', anchorIso: '2026-05-01' };
    rerender(<CalendarView />);
    expect(await screen.findByText('Week view, Apr 27 \u2013 May 3, 2026')).toBeInTheDocument();
  });

  it('marks the active mode with a filled toggle, not color alone (WCAG 1.4.1)', () => {
    calFilterMock.state = { ...calFilterMock.state, calView: 'week', anchorIso: '2026-05-01' };
    calendarTasksMock.mockReturnValue({
      tasks: [sampleTask],
      isLoading: false,
      error: null,
      refetch,
    });
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
    const week = screen.getByRole('radio', { name: 'Week' });
    expect(week).toHaveAttribute('aria-checked', 'true');
    expect(week.className).toContain('bg-brand-primary');
    expect(week.className).not.toContain('bg-brand-primary/10');
  });

  it('announces the empty window on DESKTOP too, not only in the mobile list (rule 354)', async () => {
    // The paired half of web rule 354: "this window holds no tasks" is one state
    // rendered by two breakpoint-selected components. CalendarMobileList wraps
    // its copy in role="status"; the desktop grid's hint is an absolutely
    // positioned, pointer-events-none <p> that is decoration to a screen reader.
    // The contract therefore lives on this surface's single permanent announcer.
    // CalendarMobileList.test.tsx holds the mobile half.
    const outsideWeek: Task = {
      ...sampleTask,
      id: 'outside',
      start: '2026-05-20',
      finish: '2026-05-22',
    };
    calendarTasksMock.mockReturnValue({
      tasks: [outsideWeek],
      isLoading: false,
      error: null,
      refetch,
    });
    const { rerender } = renderWithProvidersAndRouter(<CalendarView />, {
      initialEntries: ['/projects/proj-1?view=calendar'],
    });
    // Step to a week that holds none of the project's tasks.
    calFilterMock.state = { ...calFilterMock.state, calView: 'week', anchorIso: '2026-05-01' };
    rerender(<CalendarView />);
    expect(await screen.findByText(/, no tasks$/)).toBeInTheDocument();
  });

  describe('calendar-derived week start', () => {
    const SUN_THU = 64 + 1 + 2 + 4 + 8;
    const onCalendar = (working_days: number) => ({
      data: { effective_calendar: { id: 'c', name: 'C', working_days, holiday_count: 0 } },
      isLoading: false,
      error: null,
    });

    beforeEach(() => {
      calendarTasksMock.mockReturnValue({
        tasks: [sampleTask],
        isLoading: false,
        error: null,
        refetch,
      });
    });

    it('heads the week from the week start the working time resolves', () => {
      calFilterMock.state = { ...calFilterMock.state, calView: 'week', anchorIso: '2026-05-06' };
      projectMock.mockReturnValue(onCalendar(SUN_THU));
      renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('May 3 \u2013 9, 2026');
    });

    it('holds the skeleton while the layout settles, never a grid about to rotate', () => {
      workingTimeState.layoutSettling = true;
      renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
      expect(screen.getByRole('status', { name: 'Loading calendar' })).toBeInTheDocument();
      expect(screen.queryByTestId('calendar-grid')).not.toBeInTheDocument();
    });

    it('reports a failed project read to the working time', () => {
      projectMock.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') });
      renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
      expect(workingTimeSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ projectFailed: true }),
      );
    });

    it('does not call a failed refetch of a project it already holds a failure', () => {
      projectMock.mockReturnValue({ ...onCalendar(31), error: new Error('boom') });
      renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
      expect(workingTimeSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ projectFailed: false }),
      );
    });

    it('hands an incomplete working calendar to the grid', () => {
      workingTimeState.incomplete = true;
      renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
      expect(screen.getByTestId('calendar-grid')).toHaveAttribute('data-incomplete', 'true');
    });

    it('stays on Monday without a resolved calendar', () => {
      calFilterMock.state = { ...calFilterMock.state, calView: 'week', anchorIso: '2026-05-06' };
      renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('May 4 \u2013 10, 2026');
    });

    it('does not announce the week start settling when the calendar resolves', () => {
      calFilterMock.state = { ...calFilterMock.state, calView: 'week', anchorIso: '2026-05-06' };
      const { rerender } = renderWithRouter(<CalendarView />, {
        initialEntries: ['/projects/proj-1?view=calendar'],
      });
      projectMock.mockReturnValue(onCalendar(SUN_THU));
      rerender(<CalendarView />);
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('May 3 \u2013 9, 2026');
      expect(screen.queryByText(/^Week view/)).not.toBeInTheDocument();
    });
  });
});

describe('CalendarView toolbar filters and sprint header (#3169, #3170, #3171)', () => {
  const mine: Task = {
    ...sampleTask,
    id: 'mine',
    assignees: [{ resourceId: 'r-me', name: 'Me', units: 100 }],
  };
  const theirs: Task = {
    ...sampleTask,
    id: 'theirs',
    assignees: [{ resourceId: 'r-other', name: 'Other', units: 100 }],
  };
  const render = () =>
    renderWithRouter(<CalendarView />, { initialEntries: ['/projects/proj-1?view=calendar'] });
  const withTasks = (tasks: Task[]) =>
    calendarTasksMock.mockReturnValue({ tasks, isLoading: false, error: null, refetch });

  it('passes every task through when "My tasks only" is off', () => {
    withTasks([mine, theirs]);
    render();
    expect(screen.getByTestId('calendar-grid')).toHaveAttribute('data-task-ids', 'mine,theirs');
    expect(screen.getByRole('button', { name: 'My tasks only' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('narrows to the current user\'s resource when "My tasks only" is on', () => {
    calFilterMock.state.mineOnly = true;
    withTasks([mine, theirs]);
    render();
    expect(screen.getByTestId('calendar-grid')).toHaveAttribute('data-task-ids', 'mine');
    expect(screen.getByRole('button', { name: 'My tasks only' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('toggling the button writes the URL filter', async () => {
    withTasks([mine]);
    render();
    await userEvent.click(screen.getByRole('button', { name: 'My tasks only' }));
    expect(calFilterMock.setMineOnly).toHaveBeenCalledWith(true);
  });

  it('does not apply the filter while the roster lookup is in flight', () => {
    calFilterMock.state.mineOnly = true;
    myResourceState.isLoading = true;
    withTasks([mine, theirs]);
    render();
    expect(screen.getByTestId('calendar-grid')).toHaveAttribute('data-task-ids', 'mine,theirs');
  });

  it('says nothing is assigned to you, with a way out, when the filter empties a populated window', async () => {
    calFilterMock.state.mineOnly = true;
    myResourceState.resourceId = null; // no roster row linked to this user
    withTasks([theirs]);
    render();
    expect(screen.getByText('Nothing assigned to you')).toBeInTheDocument();
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show all tasks' }));
    expect(calFilterMock.setMineOnly).toHaveBeenCalledWith(false);
  });

  it('offers Group by assignee in week mode only, and passes the flag to the grid', () => {
    withTasks([mine]);
    const { unmount } = render();
    expect(screen.queryByRole('button', { name: 'Group by assignee' })).not.toBeInTheDocument();
    unmount();

    calFilterMock.state = {
      ...calFilterMock.state,
      calView: 'week',
      groupByAssignee: true,
    };
    render();
    expect(screen.getByRole('button', { name: 'Group by assignee' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('calendar-grid')).toHaveAttribute('data-group', 'true');
  });

  it('names the containing sprint in the week header, and only in week mode', () => {
    sprintsState.sprints = [
      { name: 'Sprint 7', start_date: '2026-04-20', finish_date: '2026-05-08', state: 'ACTIVE' },
    ];
    withTasks([mine]);
    const { unmount } = render();
    expect(screen.queryByTestId('calendar-week-sprint')).not.toBeInTheDocument();
    unmount();

    calFilterMock.state = { ...calFilterMock.state, calView: 'week' };
    render();
    // "Today" is real time, outside this 2026 sprint, so no days-left suffix.
    expect(screen.getByTestId('calendar-week-sprint')).toHaveTextContent('Sprint 7');
  });
});
