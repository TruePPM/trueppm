import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef, type ReactNode, type MutableRefObject } from 'react';
import { createElement } from 'react';
import { useScheduleCommit } from './useScheduleCommit';
import { useScheduleStore } from '@/stores/scheduleStore';
import { GanttEngineStub } from './engine';
import type { GanttEngine, GanttEngineEventMap, GanttScaleData } from './engine';
import type { Task, ApiSprint } from '@/types';

const { patchMock } = vi.hoisted(() => ({
  patchMock: vi.fn().mockResolvedValue({ data: {} }),
}));

vi.mock('@/api/client', () => ({
  apiClient: { patch: patchMock },
}));

// Day-1 = 0 px so leftToDate(0) = "2026-01-01". 1 px = 1 day.
const MOCK_SCALES: GanttScaleData = {
  start: new Date('2026-01-01T00:00:00Z'),
  end: new Date('2026-12-31T00:00:00Z'),
  totalWidth: 365,
  zoomLevel: 'day',
  pxPerMs: 1 / 86_400_000,
};

class ControllableEngine extends GanttEngineStub {
  private _map = new Map<string, Set<(p: unknown) => void>>();
  override readonly scales: GanttScaleData | null = MOCK_SCALES;
  override readonly scrollLeft: number = 0;
  updateTaskCalls: Array<{ id: string; patch: Partial<Task> }> = [];

  override on<K extends keyof GanttEngineEventMap>(
    event: K,
    handler: (p: GanttEngineEventMap[K]) => void,
  ): () => void {
    if (!this._map.has(event)) this._map.set(event, new Set());
    const h = handler as (p: unknown) => void;
    this._map.get(event)!.add(h);
    return () => this._map.get(event)?.delete(h);
  }

  emit<K extends keyof GanttEngineEventMap>(event: K, payload: GanttEngineEventMap[K]): void {
    this._map.get(event)?.forEach((h) => h(payload));
  }

  override updateTask(id: string, patch: Partial<Task>): void {
    this.updateTaskCalls.push({ id, patch });
  }
}

const TASK_A: Task = {
  id: 't1',
  wbs: '1',
  name: 'Task 1',
  start: '2026-01-10',
  finish: '2026-01-15',
  duration: 5,
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

const TASK_SPRINT: Task = {
  ...TASK_A,
  id: 't2',
  name: 'Sprint Task',
  sprintId: 'sp1',
};

// Calendar-consistent weekend fixture for resize math (#951). A 2-working-day
// task spanning a weekend: start Fri 2026-01-09, finish Mon 2026-01-12 (Sat/Sun
// are non-working) → duration 2. In the 1px/day MOCK_SCALES its bar's exclusive
// right edge (dateToRight) sits at day-12 px: 2026-01-12 is day 11, +1 day.
const TASK_WEEKEND: Task = {
  ...TASK_A,
  id: 'tw',
  name: 'Weekend Task',
  start: '2026-01-09',
  finish: '2026-01-12',
  duration: 2,
};

/**
 * Mon 2026-01-12 → Fri 2026-01-16, 5 working days (#2561). Finishing on a Friday is
 * the setup where dragging the handle 1–2 columns right lands on non-working time.
 */
const TASK_FRIDAY_FINISH: Task = {
  ...TASK_A,
  id: 'tf',
  name: 'Friday Finish',
  start: '2026-01-12',
  finish: '2026-01-16',
  duration: 5,
};

/** Mon–Fri (1+2+4+8+16) plus Saturday (32) — a six-day work week. */
const MASK_MON_SAT = 63;

const SPRINT_ACTIVE: ApiSprint = {
  id: 'sp1',
  server_version: 1,
  short_id: 'A1',
  short_id_display: 'SP-A1',
  name: 'Q2 2026',
  goal: '',
  notes: '',
  start_date: '2026-01-01',
  finish_date: '2026-01-14',
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
  committed_points: null,
  committed_task_count: null,
  completed_points: null,
  completed_task_count: null,
} as ApiSprint;

function makeAriaRef(): MutableRefObject<HTMLDivElement | null> {
  const ref = createRef<HTMLDivElement>() as MutableRefObject<HTMLDivElement | null>;
  ref.current = document.createElement('div');
  return ref;
}

function makeContainerRef(): MutableRefObject<HTMLDivElement | null> {
  const ref = createRef<HTMLDivElement>() as MutableRefObject<HTMLDivElement | null>;
  const el = document.createElement('div');
  // Mock getBoundingClientRect so the hook's anchor math is deterministic.
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ left: 100, top: 50, right: 1000, bottom: 800, width: 900, height: 750, x: 100, y: 50, toJSON: () => ({}) }),
  });
  ref.current = el;
  return ref;
}

/** An engine that has not laid out its scales yet — every gesture must no-op. */
class ScalelessEngine extends ControllableEngine {
  override readonly scales: GanttScaleData | null = null;
}

function renderCommit(
  engine: ControllableEngine,
  opts: {
    tasks?: Task[];
    /** Override the visible-task list (defaults to `tasks`). Used to exercise the
     *  computeAnchor row-not-found path where a task exists in allTasks but not
     *  in the currently rendered rows. */
    visibleTasks?: Task[];
    sprints?: ApiSprint[];
    onCommitSuccess?: () => void;
    projectStartDate?: string | null;
    effectiveFloorDate?: string | null;
    /** Force a container ref whose `.current` is null (computeAnchor bails). */
    nullContainer?: boolean;
    projectId?: string | null;
    /** Force an aria-live ref whose `.current` is null (announcements skipped). */
    nullAria?: boolean;
    /** Project working-day bitmask (#2561). Omitted → the hook's Mon–Fri fallback. */
    workingDaysMask?: number | null;
  } = {},
) {
  const ariaAssertiveRef = opts.nullAria
    ? (createRef<HTMLDivElement>() as MutableRefObject<HTMLDivElement | null>)
    : makeAriaRef();
  const canvasContainerRef = opts.nullContainer
    ? (createRef<HTMLDivElement>() as MutableRefObject<HTMLDivElement | null>)
    : makeContainerRef();
  const tasks = opts.tasks ?? [TASK_A];
  const sprints = opts.sprints ?? [];

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }

  const view = renderHook(
    () =>
      useScheduleCommit({
        engine,
        projectId: opts.projectId === undefined ? 'p1' : opts.projectId,
        projectStartDate: opts.projectStartDate ?? null,
        effectiveFloorDate: opts.effectiveFloorDate ?? null,
        workingDaysMask: opts.workingDaysMask,
        visibleTasks: opts.visibleTasks ?? tasks,
        allTasks: tasks,
        sprints,
        canvasContainerRef,
        ariaAssertiveRef,
        onCommitSuccess: opts.onCommitSuccess,
      }),
    { wrapper: Wrapper },
  );

  return { ...view, ariaAssertiveRef, canvasContainerRef };
}

beforeEach(() => {
  patchMock.mockClear();
  patchMock.mockResolvedValue({ data: {} });
  useScheduleStore.setState({
    zoomLevel: 'week',
    selectedTaskId: null,
    scrollToTaskId: null,
    scheduleError: null,
    scheduleActionToast: null,
    setZoomLevel: useScheduleStore.getState().setZoomLevel,
    setSelectedTaskId: useScheduleStore.getState().setSelectedTaskId,
    scrollToTask: useScheduleStore.getState().scrollToTask,
    setScheduleError: useScheduleStore.getState().setScheduleError,
    setScheduleActionToast: useScheduleStore.getState().setScheduleActionToast,
  });
});

describe('useScheduleCommit', () => {
  it('does not open the popover on a cancelled drag-task-end', () => {
    const engine = new ControllableEngine();
    const { result } = renderCommit(engine);
    act(() => engine.emit('drag-task-end', { id: 't1', left: 100, cancelled: true }));
    expect(result.current.state).toBeNull();
  });

  it('does not open the popover when drag-end lands on the same day (no net move)', () => {
    const engine = new ControllableEngine();
    const { result } = renderCommit(engine);
    // TASK_A.start = 2026-01-10, which corresponds to day 9 → x = 9 * 86_400_000 px * pxPerMs.
    // With pxPerMs = 1/86_400_000, day 9 = 9 px from origin (UTC-only arithmetic per rule 56).
    act(() => engine.emit('drag-task-end', { id: 't1', left: 9, cancelled: false }));
    expect(result.current.state).toBeNull();
    expect(engine.updateTaskCalls).toHaveLength(0);
  });

  it('opens the popover on a real drag and moves the bar via engine.updateTask', () => {
    const engine = new ControllableEngine();
    const { result } = renderCommit(engine);
    // Day 30 → 2026-01-31 in our deterministic 1-px-per-day scale
    act(() => engine.emit('drag-task-end', { id: 't1', left: 30, cancelled: false }));
    expect(result.current.state).not.toBeNull();
    expect(result.current.state!.action.kind).toBe('reschedule');
    expect(result.current.state!.action).toMatchObject({
      kind: 'reschedule',
      oldStartIso: '2026-01-10',
      newStartIso: '2026-01-31',
    });
    expect(result.current.state!.originalStart).toBe('2026-01-10');
    expect(result.current.state!.newStart).toBe('2026-01-31');
    expect(engine.updateTaskCalls).toHaveLength(1);
    expect(engine.updateTaskCalls[0]?.id).toBe('t1');
    expect(engine.updateTaskCalls[0]?.patch.start).toBe('2026-01-31');
    expect(typeof engine.updateTaskCalls[0]?.patch.finish).toBe('string');
  });

  it('opens the popover on resize with a WORKING-day duration from the dropped finish (#951)', () => {
    const engine = new ControllableEngine();
    const { result } = renderCommit(engine, { tasks: [TASK_WEEKEND] });
    // Drop the exclusive right edge at day-15 px → inclusive finish 2026-01-15
    // (Thu). The bar extends Mon 01-12 → Thu 01-15 = +3 working days, so the
    // 2-working-day task becomes 5 — NOT the 6 raw calendar days the old
    // (right − start) math would have committed.
    act(() => engine.emit('resize-task-end', { id: 'tw', right: 15, cancelled: false }));
    expect(result.current.state).not.toBeNull();
    expect(result.current.state!.action).toMatchObject({
      kind: 'resize',
      oldDurationDays: 2,
      newDurationDays: 5,
    });
    expect(result.current.state!.newDuration).toBe(5);
    expect(result.current.state!.newFinish).toBe('2026-01-15');
  });

  it('does NOT open the popover on a no-op resize grab across a weekend (#951)', () => {
    const engine = new ControllableEngine();
    const { result } = renderCommit(engine, { tasks: [TASK_WEEKEND] });
    // A no-op grab releases the handle exactly where the bar already ends:
    // TASK_WEEKEND finishes Mon 2026-01-12, whose exclusive right edge is day-12
    // px. The old calendar-day math read this back as a 4-day span vs the stored
    // working-day duration 2 and falsely opened the resize popover.
    act(() => engine.emit('resize-task-end', { id: 'tw', right: 12, cancelled: false }));
    expect(result.current.state).toBeNull();
    expect(engine.updateTaskCalls).toHaveLength(0);
  });

  // #2561: dropping the handle past a Friday finish lands on Sat/Sun, which adds no
  // working days — so the PATCH would be a no-op and the CPM refetch would redraw
  // the bar where it started. Previously this opened a "5d → 5d" popover and the bar
  // appeared to snap back after the user confirmed it.
  it.each([
    ['Saturday', 17, 'Jan 17'],
    ['Sunday', 18, 'Jan 18'],
  ])(
    'does NOT open the popover when the resize drops on %s — no duration change is possible (#2561)',
    (_label, right, dayLabel) => {
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine, { tasks: [TASK_FRIDAY_FINISH] });

      act(() => engine.emit('resize-task-end', { id: 'tf', right, cancelled: false }));

      expect(result.current.state).toBeNull();
      // No optimistic preview, and nothing sent — the bar simply stays put.
      expect(engine.updateTaskCalls).toHaveLength(0);
      expect(patchMock).not.toHaveBeenCalled();
      // The user is told why, naming the day they dropped on and the real finish.
      expect(useScheduleStore.getState().scheduleActionToast?.message).toBe(
        `${dayLabel} isn't a working day — this task still finishes Jan 16.`,
      );
    },
  );

  it('announces the suppressed resize on the assertive live region (#2561)', () => {
    const engine = new ControllableEngine();
    const { ariaAssertiveRef } = renderCommit(engine, { tasks: [TASK_FRIDAY_FINISH] });

    act(() => engine.emit('resize-task-end', { id: 'tf', right: 17, cancelled: false }));

    expect(ariaAssertiveRef.current?.textContent).toBe(
      'Resize not applied. Jan 17 is not a working day.',
    );
  });

  it('still opens the popover when the drop reaches the next WORKING day (#2561)', () => {
    const engine = new ControllableEngine();
    const { result } = renderCommit(engine, { tasks: [TASK_FRIDAY_FINISH] });

    // right=19 → inclusive finish Mon 2026-01-19: one working day past Fri 01-16.
    act(() => engine.emit('resize-task-end', { id: 'tf', right: 19, cancelled: false }));

    expect(result.current.state).not.toBeNull();
    expect(result.current.state!.action).toMatchObject({
      kind: 'resize',
      oldDurationDays: 5,
      newDurationDays: 6,
    });
    expect(result.current.state!.newFinish).toBe('2026-01-19');
  });

  // The guard must read the PROJECT's weekday mask, not a Mon–Fri constant. On a
  // six-day week Saturday IS a working day, so the identical gesture is a real
  // resize and must be offered — suppressing it would be the mirror-image bug.
  it('offers the resize when the project calendar treats Saturday as a working day (#2561)', () => {
    const engine = new ControllableEngine();
    const { result } = renderCommit(engine, {
      tasks: [TASK_FRIDAY_FINISH],
      workingDaysMask: MASK_MON_SAT,
    });

    act(() => engine.emit('resize-task-end', { id: 'tf', right: 17, cancelled: false }));

    expect(result.current.state).not.toBeNull();
    expect(result.current.state!.action).toMatchObject({
      kind: 'resize',
      oldDurationDays: 5,
      newDurationDays: 6,
    });
    expect(result.current.state!.newFinish).toBe('2026-01-17');
    expect(useScheduleStore.getState().scheduleActionToast).toBeNull();
  });

  // The mask arrives with the project-detail fetch, which resolves AFTER the engine
  // listeners subscribe. A plain closure over the prop would pin the Mon–Fri
  // fallback for the session, so a six-day-week project would keep getting the
  // suppression this fix adds — the original bug, inverted.
  it('picks up a working-day mask that arrives after the listeners subscribed (#2561)', () => {
    const engine = new ControllableEngine();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    function Wrapper({ children }: { children: ReactNode }) {
      return createElement(QueryClientProvider, { client: qc }, children);
    }
    const view = renderHook(
      ({ mask }: { mask: number | null }) =>
        useScheduleCommit({
          engine,
          projectId: 'p1',
          projectStartDate: null,
          effectiveFloorDate: null,
          workingDaysMask: mask,
          visibleTasks: [TASK_FRIDAY_FINISH],
          allTasks: [TASK_FRIDAY_FINISH],
          sprints: [],
          canvasContainerRef: makeContainerRef(),
          ariaAssertiveRef: makeAriaRef(),
        }),
      { wrapper: Wrapper, initialProps: { mask: null as number | null } },
    );

    // Detail not loaded yet → Mon–Fri fallback → a Saturday drop is a no-op.
    act(() => engine.emit('resize-task-end', { id: 'tf', right: 17, cancelled: false }));
    expect(view.result.current.state).toBeNull();

    // Detail lands: this project works Saturdays, so the same gesture is real.
    view.rerender({ mask: MASK_MON_SAT });
    act(() => engine.emit('resize-task-end', { id: 'tf', right: 17, cancelled: false }));
    expect(view.result.current.state).not.toBeNull();
    expect(view.result.current.state!.action).toMatchObject({ newDurationDays: 6 });
  });

  it('surfaces the ACTIVE sprint name on the popover state', () => {
    const engine = new ControllableEngine();
    const { result } = renderCommit(engine, {
      tasks: [TASK_SPRINT],
      sprints: [SPRINT_ACTIVE],
    });
    act(() => engine.emit('drag-task-end', { id: 't2', left: 30, cancelled: false }));
    expect(result.current.state?.activeSprintName).toBe('Q2 2026');
  });

  it('does not surface a sprint name when the sprint is PLANNED or COMPLETED', () => {
    const engine = new ControllableEngine();
    const plannedSprint: ApiSprint = { ...SPRINT_ACTIVE, state: 'PLANNED' };
    const { result } = renderCommit(engine, {
      tasks: [TASK_SPRINT],
      sprints: [plannedSprint],
    });
    act(() => engine.emit('drag-task-end', { id: 't2', left: 30, cancelled: false }));
    expect(result.current.state?.activeSprintName).toBeNull();
  });

  it('Confirm fires PATCH with planned_start and calls onCommitSuccess', async () => {
    const engine = new ControllableEngine();
    const onCommitSuccess = vi.fn();
    const { result } = renderCommit(engine, { onCommitSuccess });
    act(() => engine.emit('drag-task-end', { id: 't1', left: 30, cancelled: false }));
    act(() => result.current.handleConfirm());
    await waitFor(() => expect(onCommitSuccess).toHaveBeenCalled());
    expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { planned_start: '2026-01-31' });
    expect(result.current.state).toBeNull();
  });

  it('Confirm on resize PATCHes planned_finish, not duration (#951)', async () => {
    const engine = new ControllableEngine();
    const onCommitSuccess = vi.fn();
    const { result } = renderCommit(engine, { tasks: [TASK_WEEKEND], onCommitSuccess });
    act(() => engine.emit('resize-task-end', { id: 'tw', right: 15, cancelled: false }));
    act(() => result.current.handleConfirm());
    await waitFor(() => expect(onCommitSuccess).toHaveBeenCalled());
    // Server-authoritative: the client sends the dropped finish DATE; the API
    // derives the working-day duration from the project calendar (#951).
    expect(patchMock).toHaveBeenCalledWith('/tasks/tw/', { planned_finish: '2026-01-15' });
  });

  it('Cancel reverts the engine and clears state without firing PATCH', () => {
    const engine = new ControllableEngine();
    const { result } = renderCommit(engine);
    act(() => engine.emit('drag-task-end', { id: 't1', left: 30, cancelled: false }));
    expect(engine.updateTaskCalls).toHaveLength(1);
    act(() => result.current.handleCancel());
    expect(engine.updateTaskCalls).toHaveLength(2);
    expect(engine.updateTaskCalls[1]).toEqual({
      id: 't1',
      patch: { start: '2026-01-10', finish: '2026-01-15', duration: 5 },
    });
    expect(patchMock).not.toHaveBeenCalled();
    expect(result.current.state).toBeNull();
  });

  it('click-outside dismiss reverts the engine and surfaces a toast', () => {
    const engine = new ControllableEngine();
    const { result } = renderCommit(engine);
    act(() => engine.emit('drag-task-end', { id: 't1', left: 30, cancelled: false }));
    act(() => result.current.handleDismissByOutsideClick());
    expect(result.current.state).toBeNull();
    expect(useScheduleStore.getState().scheduleActionToast?.message).toBe(
      'Reschedule cancelled — change not saved.',
    );
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('aria-live region announces "Reschedule pending" on a real drag-end', () => {
    const engine = new ControllableEngine();
    const { ariaAssertiveRef } = renderCommit(engine);
    act(() => engine.emit('drag-task-end', { id: 't1', left: 30, cancelled: false }));
    expect(ariaAssertiveRef.current?.textContent).toBe(
      'Reschedule pending. Confirm or cancel.',
    );
  });

  it('aria-live region announces "Resize pending" on a real resize-end', () => {
    const engine = new ControllableEngine();
    const { ariaAssertiveRef } = renderCommit(engine);
    act(() => engine.emit('resize-task-end', { id: 't1', right: 19, cancelled: false }));
    expect(ariaAssertiveRef.current?.textContent).toBe(
      'Resize pending. Confirm or cancel.',
    );
  });

  it('confirm offline skips PATCH, reverts engine, and surfaces scheduleError', () => {
    const engine = new ControllableEngine();
    const onlineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { result } = renderCommit(engine);
    act(() => engine.emit('drag-task-end', { id: 't1', left: 30, cancelled: false }));
    act(() => result.current.handleConfirm());
    expect(patchMock).not.toHaveBeenCalled();
    expect(useScheduleStore.getState().scheduleError).toBe(
      "You're offline — change not saved.",
    );
    expect(result.current.state).toBeNull();
    onlineSpy.mockRestore();
  });

  // --- Project-start floor prompt (#868) -----------------------------------
  // Scale is 1px/day from 2026-01-01: left=5 → 2026-01-06, left=25 → 2026-01-26.
  describe('project-start floor (#868)', () => {
    it('Confirm before the project start opens the prompt and fires no PATCH', () => {
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine, { projectStartDate: '2026-01-20' });
      act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
      act(() => result.current.handleConfirm());
      expect(result.current.beforeStartPrompt).not.toBeNull();
      expect(result.current.beforeStartPrompt!.attemptedStart).toBe('2026-01-06');
      expect(result.current.beforeStartPrompt!.projectStartDate).toBe('2026-01-20');
      expect(result.current.state).toBeNull();
      expect(patchMock).not.toHaveBeenCalled();
    });

    it('a drag on/after the project start commits normally (no prompt)', async () => {
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine, { projectStartDate: '2026-01-20' });
      act(() => engine.emit('drag-task-end', { id: 't1', left: 25, cancelled: false }));
      act(() => result.current.handleConfirm());
      expect(result.current.beforeStartPrompt).toBeNull();
      await waitFor(() =>
        expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { planned_start: '2026-01-26' }),
      );
    });

    it('Snap re-pins the task to the project start date', async () => {
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine, { projectStartDate: '2026-01-20' });
      act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
      act(() => result.current.handleConfirm());
      act(() => result.current.handleSnapToProjectStart());
      await waitFor(() =>
        expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { planned_start: '2026-01-20' }),
      );
      await waitFor(() => expect(result.current.beforeStartPrompt).toBeNull());
    });

    it('Move project start PATCHes the project then the task', async () => {
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine, { projectStartDate: '2026-01-20' });
      act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
      act(() => result.current.handleConfirm());
      act(() => result.current.handleMoveProjectStart());
      await waitFor(() =>
        expect(patchMock).toHaveBeenCalledWith('/projects/p1/', { start_date: '2026-01-06' }),
      );
      await waitFor(() =>
        expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { planned_start: '2026-01-06' }),
      );
      await waitFor(() => expect(result.current.beforeStartPrompt).toBeNull());
    });

    it('Cancel reverts the engine bar and fires no PATCH', () => {
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine, { projectStartDate: '2026-01-20' });
      act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
      act(() => result.current.handleConfirm());
      act(() => result.current.handleCancelBeforeStart());
      expect(result.current.beforeStartPrompt).toBeNull();
      expect(patchMock).not.toHaveBeenCalled();
      const last = engine.updateTaskCalls[engine.updateTaskCalls.length - 1];
      expect(last?.patch.start).toBe('2026-01-10'); // reverted to TASK_A.start
    });

    it('Cancel-before-start surfaces the "change not saved" toast', () => {
      const engine = new ControllableEngine();
      const { ariaAssertiveRef, result } = renderCommit(engine, { projectStartDate: '2026-01-20' });
      act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
      act(() => result.current.handleConfirm());
      act(() => result.current.handleCancelBeforeStart());
      expect(useScheduleStore.getState().scheduleActionToast?.message).toBe(
        'Reschedule cancelled — change not saved.',
      );
      expect(ariaAssertiveRef.current?.textContent).toBe('Reschedule cancelled.');
    });

    it('uses effectiveFloorDate (not the literal start) as the block threshold', async () => {
      // Literal start 2026-01-20 but the effective working-day floor is 2026-01-19.
      // A drag to 2026-01-19 (left=18) is AT the floor → commits, no prompt —
      // proving the floor, not projectStartDate, gates the check.
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine, {
        projectStartDate: '2026-01-20',
        effectiveFloorDate: '2026-01-19',
      });
      act(() => engine.emit('drag-task-end', { id: 't1', left: 18, cancelled: false }));
      act(() => result.current.handleConfirm());
      expect(result.current.beforeStartPrompt).toBeNull();
      await waitFor(() =>
        expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { planned_start: '2026-01-19' }),
      );
    });

    it('Snap targets the effective working-day floor, not the literal start', async () => {
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine, {
        projectStartDate: '2026-01-20',
        effectiveFloorDate: '2026-01-19',
      });
      // Drag to 2026-01-06 (left=5) — before the floor → prompt.
      act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
      act(() => result.current.handleConfirm());
      expect(result.current.beforeStartPrompt!.effectiveFloorDate).toBe('2026-01-19');
      act(() => result.current.handleSnapToProjectStart());
      await waitFor(() =>
        expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { planned_start: '2026-01-19' }),
      );
    });

    it('falls back to projectStartDate for the prompt header when no floor given', () => {
      // effectiveFloorDate null → prompt.projectStartDate comes from projectStartDate.
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine, {
        projectStartDate: '2026-01-20',
        effectiveFloorDate: null,
      });
      act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
      act(() => result.current.handleConfirm());
      expect(result.current.beforeStartPrompt!.projectStartDate).toBe('2026-01-20');
      expect(result.current.beforeStartPrompt!.effectiveFloorDate).toBe('2026-01-20');
    });

    it('uses effectiveFloorDate for the prompt header when projectStartDate is null', () => {
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine, {
        projectStartDate: null,
        effectiveFloorDate: '2026-01-20',
      });
      act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
      act(() => result.current.handleConfirm());
      expect(result.current.beforeStartPrompt!.projectStartDate).toBe('2026-01-20');
    });

    it('Snap while offline reverts the bar and surfaces scheduleError without a PATCH', () => {
      const engine = new ControllableEngine();
      const onlineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      const { result } = renderCommit(engine, { projectStartDate: '2026-01-20' });
      // Set up the prompt while "online".
      onlineSpy.mockReturnValue(true);
      act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
      act(() => result.current.handleConfirm());
      onlineSpy.mockReturnValue(false);
      act(() => result.current.handleSnapToProjectStart());
      expect(patchMock).not.toHaveBeenCalled();
      expect(useScheduleStore.getState().scheduleError).toBe("You're offline — change not saved.");
      expect(result.current.beforeStartPrompt).toBeNull();
      const last = engine.updateTaskCalls[engine.updateTaskCalls.length - 1];
      expect(last?.patch.start).toBe('2026-01-10'); // reverted to original
      onlineSpy.mockRestore();
    });

    it('Move-project-start while offline reverts the bar and surfaces scheduleError', () => {
      const engine = new ControllableEngine();
      const onlineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
      const { result } = renderCommit(engine, { projectStartDate: '2026-01-20' });
      act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
      act(() => result.current.handleConfirm());
      onlineSpy.mockReturnValue(false);
      act(() => result.current.handleMoveProjectStart());
      expect(patchMock).not.toHaveBeenCalled();
      expect(useScheduleStore.getState().scheduleError).toBe("You're offline — change not saved.");
      expect(result.current.beforeStartPrompt).toBeNull();
      onlineSpy.mockRestore();
    });

    it('Snap keeps the prompt open with the server error message on PATCH failure', async () => {
      const engine = new ControllableEngine();
      patchMock.mockRejectedValueOnce({ response: { data: { detail: 'Still too early.' } } });
      const { result } = renderCommit(engine, { projectStartDate: '2026-01-20' });
      act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
      act(() => result.current.handleConfirm());
      act(() => result.current.handleSnapToProjectStart());
      await waitFor(() => expect(result.current.beforeStartPrompt?.error).toBe('Still too early.'));
      // Prompt stays open so the user can retry.
      expect(result.current.beforeStartPrompt).not.toBeNull();
    });

    it('Move-project-start surfaces a permission error when the project PATCH is rejected', async () => {
      const engine = new ControllableEngine();
      // Reject the /projects/ PATCH (Admin+ enforced server-side); the task PATCH
      // must NOT fire because the first step failed.
      patchMock.mockImplementation((url: string) =>
        url.startsWith('/projects/')
          ? Promise.reject(
              Object.assign(new Error('forbidden'), {
                response: { data: { detail: 'Only admins may move the start date.' } },
              }),
            )
          : Promise.resolve({ data: {} }),
      );
      const { result } = renderCommit(engine, { projectStartDate: '2026-01-20' });
      act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
      act(() => result.current.handleConfirm());
      act(() => result.current.handleMoveProjectStart());
      await waitFor(() =>
        expect(result.current.beforeStartPrompt?.error).toBe('Only admins may move the start date.'),
      );
      expect(patchMock).not.toHaveBeenCalledWith('/tasks/t1/', expect.anything());
    });

    it('Move-project-start surfaces the "task save failed" fallback when only the task PATCH fails', async () => {
      const engine = new ControllableEngine();
      // Project PATCH succeeds, task PATCH rejects with no DRF detail → fallback copy.
      patchMock.mockImplementation((url: string) =>
        url.startsWith('/projects/')
          ? Promise.resolve({ data: {} })
          : Promise.reject(Object.assign(new Error('task save failed'), { response: { data: {} } })),
      );
      const { result } = renderCommit(engine, { projectStartDate: '2026-01-20' });
      act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
      act(() => result.current.handleConfirm());
      act(() => result.current.handleMoveProjectStart());
      await waitFor(() =>
        expect(result.current.beforeStartPrompt?.error).toBe(
          'Moved the project start, but saving the task failed. Try again.',
        ),
      );
    });

    it('Snap does nothing when there is no active prompt', () => {
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine, { projectStartDate: '2026-01-20' });
      act(() => result.current.handleSnapToProjectStart());
      act(() => result.current.handleMoveProjectStart());
      act(() => result.current.handleCancelBeforeStart());
      expect(patchMock).not.toHaveBeenCalled();
      expect(engine.updateTaskCalls).toHaveLength(0);
    });
  });

  // --- extractErrorMessage variants via the snap onError path ---------------
  describe('error-message extraction', () => {
    function snapWithRejection(reason: unknown) {
      const engine = new ControllableEngine();
      patchMock.mockRejectedValueOnce(reason);
      const { result } = renderCommit(engine, { projectStartDate: '2026-01-20' });
      act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
      act(() => result.current.handleConfirm());
      act(() => result.current.handleSnapToProjectStart());
      return result;
    }

    it('prefers the DRF `detail` string', async () => {
      const result = snapWithRejection({ response: { data: { detail: 'A detail message.' } } });
      await waitFor(() => expect(result.current.beforeStartPrompt?.error).toBe('A detail message.'));
    });

    it('falls back to the first field error array', async () => {
      const result = snapWithRejection({
        response: { data: { planned_start: ['Date is invalid.'] } },
      });
      await waitFor(() => expect(result.current.beforeStartPrompt?.error).toBe('Date is invalid.'));
    });

    it('falls back to a first field error that is a bare string', async () => {
      const result = snapWithRejection({ response: { data: { non_field: 'Bare string error.' } } });
      await waitFor(() => expect(result.current.beforeStartPrompt?.error).toBe('Bare string error.'));
    });

    it('uses the fallback copy when the payload has no usable shape', async () => {
      const result = snapWithRejection(new Error('network down'));
      await waitFor(() =>
        expect(result.current.beforeStartPrompt?.error).toBe("Couldn't save the change. Try again."),
      );
    });
  });

  // --- Confirm PATCH failure keeps the popover open (retry path) ------------
  describe('confirm PATCH failure', () => {
    it('keeps the popover open and shows the server detail on error', async () => {
      const engine = new ControllableEngine();
      patchMock.mockRejectedValueOnce({ response: { data: { detail: 'Task is locked.' } } });
      const { result } = renderCommit(engine);
      act(() => engine.emit('drag-task-end', { id: 't1', left: 30, cancelled: false }));
      act(() => result.current.handleConfirm());
      await waitFor(() => expect(result.current.state?.error).toBe('Task is locked.'));
      // Popover stays open so the user can Retry or Cancel.
      expect(result.current.state).not.toBeNull();
    });

    it('uses the generic fallback copy when the error has no detail', async () => {
      const engine = new ControllableEngine();
      patchMock.mockRejectedValueOnce(new Error('boom'));
      const { result } = renderCommit(engine);
      act(() => engine.emit('drag-task-end', { id: 't1', left: 30, cancelled: false }));
      act(() => result.current.handleConfirm());
      await waitFor(() =>
        expect(result.current.state?.error).toBe("Couldn't save the change. Try again or cancel."),
      );
    });
  });

  // --- Guard clauses & no-op branches --------------------------------------
  describe('guards and no-op branches', () => {
    it('drag-end on an unknown task id opens nothing', () => {
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine);
      act(() => engine.emit('drag-task-end', { id: 'ghost', left: 30, cancelled: false }));
      expect(result.current.state).toBeNull();
      expect(engine.updateTaskCalls).toHaveLength(0);
    });

    it('drag-end whose task is not in the visible rows moves the bar but opens no popover', () => {
      // computeAnchor returns null (rowIndex < 0) → setState is skipped even
      // though the visual preview already moved.
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine, { visibleTasks: [] });
      act(() => engine.emit('drag-task-end', { id: 't1', left: 30, cancelled: false }));
      expect(engine.updateTaskCalls).toHaveLength(1); // preview moved
      expect(result.current.state).toBeNull(); // but no popover
    });

    it('drag-end bails when the container ref is null (no anchor)', () => {
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine, { nullContainer: true });
      act(() => engine.emit('drag-task-end', { id: 't1', left: 30, cancelled: false }));
      expect(result.current.state).toBeNull();
    });

    it('resize-end returns early when the task has no start date', () => {
      const engine = new ControllableEngine();
      const startless: Task = { ...TASK_A, id: 'ns', start: '' };
      const { result } = renderCommit(engine, { tasks: [startless] });
      act(() => engine.emit('resize-task-end', { id: 'ns', right: 30, cancelled: false }));
      expect(result.current.state).toBeNull();
      expect(engine.updateTaskCalls).toHaveLength(0);
    });

    it('resize-end returns early when the dropped finish is before the start', () => {
      // TASK_A start 2026-01-10; drop the edge at day-5 px → finish ~2026-01-04
      // which is before the start → invalid, no popover.
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine);
      act(() => engine.emit('resize-task-end', { id: 't1', right: 5, cancelled: false }));
      expect(result.current.state).toBeNull();
      expect(engine.updateTaskCalls).toHaveLength(0);
    });

    it('handleCancel is a no-op when no popover is open', () => {
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine);
      act(() => result.current.handleCancel());
      expect(engine.updateTaskCalls).toHaveLength(0);
    });

    it('handleDismissByOutsideClick is a no-op when no popover is open', () => {
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine);
      act(() => result.current.handleDismissByOutsideClick());
      expect(useScheduleStore.getState().scheduleActionToast).toBeNull();
    });

    it('handleConfirm is a no-op when no popover is open', () => {
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine);
      act(() => result.current.handleConfirm());
      expect(patchMock).not.toHaveBeenCalled();
    });

    it('a task without a sprint has a null activeSprintName', () => {
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine, { tasks: [TASK_A], sprints: [SPRINT_ACTIVE] });
      act(() => engine.emit('drag-task-end', { id: 't1', left: 30, cancelled: false }));
      expect(result.current.state?.activeSprintName).toBeNull();
    });
  });

  // --- Resize-specific cancel/dismiss copy ---------------------------------
  describe('resize cancel/dismiss announcements', () => {
    it('Cancel on a resize announces "Resize cancelled."', () => {
      const engine = new ControllableEngine();
      const { ariaAssertiveRef, result } = renderCommit(engine);
      act(() => engine.emit('resize-task-end', { id: 't1', right: 19, cancelled: false }));
      act(() => result.current.handleCancel());
      expect(ariaAssertiveRef.current?.textContent).toBe('Resize cancelled.');
    });

    it('click-outside on a resize surfaces the resize-specific toast', () => {
      const engine = new ControllableEngine();
      const { result } = renderCommit(engine);
      act(() => engine.emit('resize-task-end', { id: 't1', right: 19, cancelled: false }));
      act(() => result.current.handleDismissByOutsideClick());
      expect(useScheduleStore.getState().scheduleActionToast?.message).toBe(
        'Resize cancelled — change not saved.',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Subscription guards — the hook must not react to engine gestures at all when
// it has nothing to commit against (no project) or nothing to measure against
// (no laid-out scales).
// ---------------------------------------------------------------------------

describe('useScheduleCommit — subscription guards', () => {
  it('ignores drag and resize gestures when there is no projectId', () => {
    const engine = new ControllableEngine();
    const { result } = renderCommit(engine, { projectId: null });
    act(() => engine.emit('drag-task-end', { id: 't1', left: 30, cancelled: false }));
    act(() => engine.emit('resize-task-end', { id: 't1', right: 19, cancelled: false }));
    expect(result.current.state).toBeNull();
    expect(engine.updateTaskCalls).toHaveLength(0);
  });

  it('ignores drag and resize gestures before the engine has laid out its scales', () => {
    const engine = new ScalelessEngine();
    const { result } = renderCommit(engine);
    act(() => engine.emit('drag-task-end', { id: 't1', left: 30, cancelled: false }));
    act(() => engine.emit('resize-task-end', { id: 't1', right: 19, cancelled: false }));
    expect(result.current.state).toBeNull();
    expect(engine.updateTaskCalls).toHaveLength(0);
  });

  it('does not open the popover on a cancelled resize-task-end', () => {
    const engine = new ControllableEngine();
    const { result } = renderCommit(engine);
    act(() => engine.emit('resize-task-end', { id: 't1', right: 19, cancelled: true }));
    expect(result.current.state).toBeNull();
    expect(engine.updateTaskCalls).toHaveLength(0);
  });

  it('resize-end whose task is not in the visible rows moves the bar but opens no popover', () => {
    // Mirror of the drag-side case: computeAnchor returns null (rowIndex < 0) so
    // the popover is suppressed even though the preview has already moved.
    const engine = new ControllableEngine();
    const { result } = renderCommit(engine, { visibleTasks: [] });
    act(() => engine.emit('resize-task-end', { id: 't1', right: 19, cancelled: false }));
    expect(engine.updateTaskCalls).toHaveLength(1);
    expect(result.current.state).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Announcements are best-effort — every flow must still work when the host has
// not mounted the aria-live region (ref.current === null).
// ---------------------------------------------------------------------------

describe('useScheduleCommit — missing aria-live region', () => {
  it('drag → cancel still reverts the bar with no live region mounted', () => {
    const engine = new ControllableEngine();
    const { result, ariaAssertiveRef } = renderCommit(engine, { nullAria: true });
    expect(ariaAssertiveRef.current).toBeNull();
    act(() => engine.emit('drag-task-end', { id: 't1', left: 30, cancelled: false }));
    expect(result.current.state).not.toBeNull();
    act(() => result.current.handleCancel());
    expect(result.current.state).toBeNull();
    expect(engine.updateTaskCalls[1]?.patch.start).toBe('2026-01-10');
  });

  it('resize → click-outside still toasts with no live region mounted', () => {
    const engine = new ControllableEngine();
    const { result } = renderCommit(engine, { nullAria: true });
    act(() => engine.emit('resize-task-end', { id: 't1', right: 19, cancelled: false }));
    expect(result.current.state).not.toBeNull();
    act(() => result.current.handleDismissByOutsideClick());
    expect(useScheduleStore.getState().scheduleActionToast?.message).toBe(
      'Resize cancelled — change not saved.',
    );
    expect(result.current.state).toBeNull();
  });

  it('drag → confirm still PATCHes with no live region mounted', async () => {
    const engine = new ControllableEngine();
    const onCommitSuccess = vi.fn();
    const { result } = renderCommit(engine, { nullAria: true, onCommitSuccess });
    act(() => engine.emit('drag-task-end', { id: 't1', left: 30, cancelled: false }));
    act(() => result.current.handleConfirm());
    await waitFor(() => expect(onCommitSuccess).toHaveBeenCalled());
    expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { planned_start: '2026-01-31' });
  });

  it('before-start prompt → snap → cancel all work with no live region mounted', async () => {
    const engine = new ControllableEngine();
    const { result } = renderCommit(engine, {
      nullAria: true,
      projectStartDate: '2026-01-20',
    });
    act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
    act(() => result.current.handleConfirm());
    expect(result.current.beforeStartPrompt).not.toBeNull();
    act(() => result.current.handleSnapToProjectStart());
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { planned_start: '2026-01-20' }),
    );
    await waitFor(() => expect(result.current.beforeStartPrompt).toBeNull());
  });

  it('move-project-start succeeds with no live region mounted', async () => {
    const engine = new ControllableEngine();
    const { result } = renderCommit(engine, {
      nullAria: true,
      projectStartDate: '2026-01-20',
    });
    act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
    act(() => result.current.handleConfirm());
    act(() => result.current.handleMoveProjectStart());
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/projects/p1/', { start_date: '2026-01-06' }),
    );
    await waitFor(() => expect(result.current.beforeStartPrompt).toBeNull());
  });

  it('cancel-before-start still toasts with no live region mounted', () => {
    const engine = new ControllableEngine();
    const { result } = renderCommit(engine, {
      nullAria: true,
      projectStartDate: '2026-01-20',
    });
    act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
    act(() => result.current.handleConfirm());
    act(() => result.current.handleCancelBeforeStart());
    expect(result.current.beforeStartPrompt).toBeNull();
    expect(useScheduleStore.getState().scheduleActionToast?.message).toBe(
      'Reschedule cancelled — change not saved.',
    );
  });
});

// ---------------------------------------------------------------------------
// The engine can be torn down (canvas unmount / re-init) while a popover or
// floor prompt is still open. Every handler must degrade to "state only".
// ---------------------------------------------------------------------------

/** Render with a swappable engine so a test can drop it to null mid-flow. */
function renderCommitWithSwappableEngine(opts: { projectStartDate?: string | null } = {}) {
  const engine = new ControllableEngine();
  const ariaAssertiveRef = makeAriaRef();
  const canvasContainerRef = makeContainerRef();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }

  const view = renderHook(
    ({ engine: current }: { engine: GanttEngine | null }) =>
      useScheduleCommit({
        engine: current,
        projectId: 'p1',
        projectStartDate: opts.projectStartDate ?? null,
        effectiveFloorDate: null,
        visibleTasks: [TASK_A],
        allTasks: [TASK_A],
        sprints: [],
        canvasContainerRef,
        ariaAssertiveRef,
      }),
    { wrapper: Wrapper, initialProps: { engine: engine as GanttEngine | null } },
  );

  return { ...view, engine, ariaAssertiveRef };
}

describe('useScheduleCommit — engine torn down mid-flow', () => {
  it('Cancel clears the popover without a revert when the engine is gone', () => {
    const { result, rerender, engine } = renderCommitWithSwappableEngine();
    act(() => engine.emit('drag-task-end', { id: 't1', left: 30, cancelled: false }));
    expect(engine.updateTaskCalls).toHaveLength(1);
    rerender({ engine: null });
    act(() => result.current.handleCancel());
    expect(result.current.state).toBeNull();
    // No second updateTask: there is no engine left to revert.
    expect(engine.updateTaskCalls).toHaveLength(1);
  });

  it('offline Snap clears the prompt without a revert when the engine is gone', () => {
    const onlineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const { result, rerender, engine } = renderCommitWithSwappableEngine({
      projectStartDate: '2026-01-20',
    });
    act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
    act(() => result.current.handleConfirm());
    rerender({ engine: null });
    onlineSpy.mockReturnValue(false);
    act(() => result.current.handleSnapToProjectStart());
    expect(result.current.beforeStartPrompt).toBeNull();
    expect(useScheduleStore.getState().scheduleError).toBe("You're offline — change not saved.");
    expect(engine.updateTaskCalls).toHaveLength(1);
    expect(patchMock).not.toHaveBeenCalled();
    onlineSpy.mockRestore();
  });

  it('online Snap still PATCHes when the engine is gone (no preview to move)', async () => {
    const { result, rerender, engine } = renderCommitWithSwappableEngine({
      projectStartDate: '2026-01-20',
    });
    act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
    act(() => result.current.handleConfirm());
    rerender({ engine: null });
    act(() => result.current.handleSnapToProjectStart());
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { planned_start: '2026-01-20' }),
    );
    expect(engine.updateTaskCalls).toHaveLength(1);
  });

  it('offline move-project-start clears the prompt when the engine is gone', () => {
    const onlineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const { result, rerender, engine } = renderCommitWithSwappableEngine({
      projectStartDate: '2026-01-20',
    });
    act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
    act(() => result.current.handleConfirm());
    rerender({ engine: null });
    onlineSpy.mockReturnValue(false);
    act(() => result.current.handleMoveProjectStart());
    expect(result.current.beforeStartPrompt).toBeNull();
    expect(useScheduleStore.getState().scheduleError).toBe("You're offline — change not saved.");
    expect(patchMock).not.toHaveBeenCalled();
    onlineSpy.mockRestore();
  });

  it('Cancel-before-start clears the prompt and toasts when the engine is gone', () => {
    const { result, rerender, engine } = renderCommitWithSwappableEngine({
      projectStartDate: '2026-01-20',
    });
    act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
    act(() => result.current.handleConfirm());
    rerender({ engine: null });
    act(() => result.current.handleCancelBeforeStart());
    expect(result.current.beforeStartPrompt).toBeNull();
    expect(useScheduleStore.getState().scheduleActionToast?.message).toBe(
      'Reschedule cancelled — change not saved.',
    );
    expect(engine.updateTaskCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A user who cancels before an in-flight PATCH settles must not have the
// popover/prompt resurrected by the late failure.
// ---------------------------------------------------------------------------

describe('useScheduleCommit — late failures after the user has moved on', () => {
  it('a confirm rejection after Cancel does not re-open the popover', async () => {
    const engine = new ControllableEngine();
    let rejectPatch: (reason: unknown) => void = () => {};
    patchMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPatch = reject;
        }),
    );
    const { result } = renderCommit(engine);
    act(() => engine.emit('drag-task-end', { id: 't1', left: 30, cancelled: false }));
    act(() => result.current.handleConfirm());
    // onMutate awaits cancelQueries, so the PATCH is issued a microtask later.
    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    act(() => result.current.handleCancel());
    expect(result.current.state).toBeNull();

    await act(async () => {
      rejectPatch({ response: { data: { detail: 'Task is locked.' } } });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.state).toBeNull();
  });

  it('a snap rejection after Cancel does not re-open the floor prompt', async () => {
    const engine = new ControllableEngine();
    let rejectPatch: (reason: unknown) => void = () => {};
    patchMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPatch = reject;
        }),
    );
    const { result } = renderCommit(engine, { projectStartDate: '2026-01-20' });
    act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
    act(() => result.current.handleConfirm());
    act(() => result.current.handleSnapToProjectStart());
    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    act(() => result.current.handleCancelBeforeStart());
    expect(result.current.beforeStartPrompt).toBeNull();

    await act(async () => {
      rejectPatch({ response: { data: { detail: 'Still too early.' } } });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.beforeStartPending).toBe(false));
    expect(result.current.beforeStartPrompt).toBeNull();
  });

  it('a project-start rejection after Cancel does not re-open the floor prompt', async () => {
    const engine = new ControllableEngine();
    let rejectPatch: (reason: unknown) => void = () => {};
    patchMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPatch = reject;
        }),
    );
    const { result } = renderCommit(engine, { projectStartDate: '2026-01-20' });
    act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
    act(() => result.current.handleConfirm());
    act(() => result.current.handleMoveProjectStart());
    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    act(() => result.current.handleCancelBeforeStart());
    expect(result.current.beforeStartPrompt).toBeNull();

    await act(async () => {
      rejectPatch({ response: { data: { detail: 'Admins only.' } } });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.beforeStartPending).toBe(false));
    expect(result.current.beforeStartPrompt).toBeNull();
  });

  it('a task rejection after a successful project move does not re-open a cancelled prompt', async () => {
    const engine = new ControllableEngine();
    let rejectTask: (reason: unknown) => void = () => {};
    patchMock.mockImplementation((url: string) =>
      url.startsWith('/projects/')
        ? Promise.resolve({ data: {} })
        : new Promise((_resolve, reject) => {
            rejectTask = reject;
          }),
    );
    const { result } = renderCommit(engine, { projectStartDate: '2026-01-20' });
    act(() => engine.emit('drag-task-end', { id: 't1', left: 5, cancelled: false }));
    act(() => result.current.handleConfirm());
    act(() => result.current.handleMoveProjectStart());
    // Wait for step 1 (project PATCH) to settle and step 2 (task PATCH) to fire.
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { planned_start: '2026-01-06' }),
    );
    act(() => result.current.handleCancelBeforeStart());
    expect(result.current.beforeStartPrompt).toBeNull();

    await act(async () => {
      rejectTask({ response: { data: {} } });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.beforeStartPending).toBe(false));
    expect(result.current.beforeStartPrompt).toBeNull();
  });
});
