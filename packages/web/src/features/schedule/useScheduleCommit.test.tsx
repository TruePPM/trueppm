import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef, type ReactNode, type MutableRefObject } from 'react';
import { createElement } from 'react';
import { useScheduleCommit } from './useScheduleCommit';
import { useScheduleStore } from '@/stores/scheduleStore';
import { GanttEngineStub } from './engine';
import type { GanttEngineEventMap, GanttScaleData } from './engine';
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
  override readonly scales: GanttScaleData = MOCK_SCALES;
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
  } = {},
) {
  const ariaAssertiveRef = makeAriaRef();
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
