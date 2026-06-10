/**
 * useProjectWebSocket unit tests — focused on the `dependency_*` handlers
 * added in #314 so collaborators see new/edited dep edges (and their CPM
 * cascade) immediately rather than after the next 2 s poll.
 *
 * The real `WebSocket` constructor is replaced with a mock that captures the
 * latest instance and lets tests dispatch synthetic message events.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useProjectWebSocket } from './useProjectWebSocket';
import { useAuthStore } from '@/stores/authStore';
import type { Task } from '@/types';

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = 0;
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (e: unknown) => void) {
    (this.listeners[type] ||= []).push(cb);
  }

  removeEventListener(type: string, cb: (e: unknown) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((fn) => fn !== cb);
  }

  dispatch(type: string, event: unknown) {
    (this.listeners[type] ?? []).forEach((cb) => {
      cb(event);
    });
  }
}

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useProjectWebSocket — dependency event handlers (#314)', () => {
  const originalWebSocket = globalThis.WebSocket;
  let qc: QueryClient;

  beforeEach(() => {
    // Gantt-data invalidations (tasks/dependencies) are trailing-debounced
    // (#773), so a burst of events flushes as one invalidation per key after
    // ~300 ms. Fake timers let us advance past that window deterministically.
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    // @ts-expect-error — overriding WebSocket for the test environment
    globalThis.WebSocket = MockWebSocket;
    act(() => {
      useAuthStore.setState({
        accessToken: 'tok-abc',
        isAuthenticated: true,
      });
    });
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    act(() => {
      useAuthStore.setState({
        accessToken: null,
        isAuthenticated: false,
      });
    });
  });

  function dispatchEvent(eventType: string) {
    act(() => {
      MockWebSocket.instances[0].dispatch('message', {
        data: JSON.stringify({ event_type: eventType, payload: { id: 'dep-1' } }),
      });
    });
  }

  /** Advance past the trailing-debounce window so coalesced invalidations fire. */
  function flushDebounce() {
    act(() => {
      vi.advanceTimersByTime(400);
    });
  }

  it('invalidates dependencies and tasks on dependency_created', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchEvent('dependency_created');
    flushDebounce();

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dependencies', 'proj-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it('invalidates dependencies and tasks on dependency_updated', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchEvent('dependency_updated');
    flushDebounce();

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dependencies', 'proj-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it('invalidates dependencies and tasks on dependency_deleted', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchEvent('dependency_deleted');
    flushDebounce();

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dependencies', 'proj-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it('does not invalidate dependencies for unrelated events', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchEvent('task_created');
    flushDebounce();

    // task_created invalidates ['tasks'] only, never ['dependencies'].
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: ['dependencies', 'proj-1'],
    });
  });

  // Project lifecycle events (#780) — archive/unarchive/transfer/hard-delete
  // had no client handler, so a project changing under the user went unnoticed.

  it('invalidates project and projects list on project_archived', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchEvent('project_archived');

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['project', 'proj-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
  });

  it('invalidates project and projects list on project_transferred', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchEvent('project_transferred');

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['project', 'proj-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
  });

  // ADR-0074 — sprint state and rollup events both refresh tasks ----------

  it('invalidates tasks AND sprints on sprint_closed (rollup may have changed)', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchEvent('sprint_closed');
    // sprints invalidates immediately; tasks is coalesced.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sprints', 'proj-1'] });
    flushDebounce();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it('invalidates tasks and sprints on milestone_rollup_updated', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchEvent('milestone_rollup_updated');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sprints', 'proj-1'] });
    flushDebounce();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  // ADR-0106 §3.4 (#1007) — a sprint close reforecast pushes the new milestone
  // range to peers; the forecast read + promote-dialog preview must refresh.
  it('invalidates the project forecast, milestone list, and reforecast preview on milestone_forecast_updated', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchEvent('milestone_forecast_updated');

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['project', 'proj-1', 'forecast'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['project-milestones', 'proj-1'] });
    // The open promote dialog's live preview is keyed by sprint id, so it is
    // matched by a predicate that targets the 'reforecast-preview' query family.
    const predicateCall = invalidateSpy.mock.calls.find(
      ([arg]) => typeof (arg as { predicate?: unknown }).predicate === 'function',
    );
    expect(predicateCall).toBeDefined();
    const { predicate } = predicateCall![0] as unknown as {
      predicate: (q: { queryKey: readonly unknown[] }) => boolean;
    };
    expect(predicate({ queryKey: ['reforecast-preview', 'sp-1', null] })).toBe(true);
    expect(predicate({ queryKey: ['sprints', 'proj-1'] })).toBe(false);
  });

  // ADR-0102 — a peer accepting/rejecting a pending scope injection must also
  // refetch the affected sprint's burndown (a separate query key from the
  // sprint list), or a peer with the chart open keeps the pre-decision curve.

  it('invalidates the targeted burndown on sprint_scope_changed when the payload carries sprint_id', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    act(() => {
      MockWebSocket.instances[0].dispatch('message', {
        data: JSON.stringify({
          event_type: 'sprint_scope_changed',
          payload: { sprint_id: 's1', task_id: 't1' },
        }),
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sprints', 'proj-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sprint', 's1', 'burndown'] });
    flushDebounce();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it('invalidates all burndown queries on sprint_scope_changed when sprint_id is absent', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    act(() => {
      MockWebSocket.instances[0].dispatch('message', {
        data: JSON.stringify({ event_type: 'sprint_scope_changed', payload: {} }),
      });
    });

    // No exact sprint id → fall back to the predicate form that matches any
    // ['sprint', <id>, 'burndown'] key.
    const predicateCall = invalidateSpy.mock.calls.find(
      ([arg]) => typeof (arg as { predicate?: unknown }).predicate === 'function',
    );
    expect(predicateCall).toBeDefined();
  });

  // --- Trailing-debounce coalescing (#773) ------------------------------

  it('coalesces a burst of task events into a single tasks invalidation', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    // Simulate a sync batch: one event per row.
    dispatchEvent('task_updated');
    dispatchEvent('task_updated');
    dispatchEvent('task_created');
    dispatchEvent('task_deleted');

    // Nothing fires until the burst goes quiet.
    const tasksCallsBefore = invalidateSpy.mock.calls.filter(
      ([arg]) => Array.isArray(arg?.queryKey) && arg.queryKey[0] === 'tasks',
    ).length;
    expect(tasksCallsBefore).toBe(0);

    flushDebounce();

    const tasksCallsAfter = invalidateSpy.mock.calls.filter(
      ([arg]) => Array.isArray(arg?.queryKey) && arg.queryKey[0] === 'tasks',
    ).length;
    // Four events → exactly one coalesced invalidation.
    expect(tasksCallsAfter).toBe(1);
  });

  it('still fires a trailing tasks invalidation for a single event', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchEvent('task_updated');
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });

    flushDebounce();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it('coalesces dependency and task keys independently within one burst', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchEvent('dependency_created');
    dispatchEvent('dependency_created');
    dispatchEvent('task_updated');
    flushDebounce();

    const depsCalls = invalidateSpy.mock.calls.filter(
      ([arg]) => Array.isArray(arg?.queryKey) && arg.queryKey[0] === 'dependencies',
    ).length;
    const tasksCalls = invalidateSpy.mock.calls.filter(
      ([arg]) => Array.isArray(arg?.queryKey) && arg.queryKey[0] === 'tasks',
    ).length;
    expect(depsCalls).toBe(1);
    expect(tasksCalls).toBe(1);
  });
});

describe('useProjectWebSocket — auth close-code handling (#352)', () => {
  const originalWebSocket = globalThis.WebSocket;
  let qc: QueryClient;

  beforeEach(() => {
    MockWebSocket.instances = [];
    // @ts-expect-error — overriding WebSocket for the test environment
    globalThis.WebSocket = MockWebSocket;
    act(() => {
      useAuthStore.setState({
        accessToken: 'tok-abc',
        isAuthenticated: true,
        sessionExpired: false,
      });
    });
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    act(() => {
      useAuthStore.setState({
        accessToken: null,
        isAuthenticated: false,
        sessionExpired: false,
      });
    });
  });

  it('marks the session expired and dispatches the auth event on WS close 4001', () => {
    const eventSpy = vi.fn();
    window.addEventListener('auth:sessionExpired', eventSpy);
    try {
      renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });
      act(() => {
        MockWebSocket.instances[0].dispatch('close', { code: 4001 });
      });
      expect(useAuthStore.getState().sessionExpired).toBe(true);
      expect(eventSpy).toHaveBeenCalled();
    } finally {
      window.removeEventListener('auth:sessionExpired', eventSpy);
    }
  });

  it('does not mark the session expired on a normal close (network drop)', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });
    act(() => {
      MockWebSocket.instances[0].dispatch('close', { code: 1006 });
    });
    expect(useAuthStore.getState().sessionExpired).toBe(false);
  });
});

describe('useProjectWebSocket — task_dates_updated splice (ADR-0091)', () => {
  const originalWebSocket = globalThis.WebSocket;
  let qc: QueryClient;

  // Minimal cached Task[] shape — only the fields the splice touches matter here.
  function seedTasks() {
    const tasks = [
      {
        id: 't1',
        name: 'Alpha',
        start: '2026-10-05',
        finish: '2026-10-15',
        duration: 10,
        isCritical: false,
        totalFloat: 5,
        plannedStart: null,
        isSummary: false,
        progress: 0,
        status: 'NOT_STARTED',
      },
      {
        id: 't2',
        name: 'Beta',
        start: '2026-10-16',
        finish: '2026-10-20',
        duration: 4,
        isCritical: false,
        totalFloat: 2,
        plannedStart: null,
        isSummary: false,
        progress: 0,
        status: 'NOT_STARTED',
      },
    ] as unknown as Task[];
    qc.setQueryData(['tasks', 'proj-1'], tasks);
  }

  function dispatch(payload: Record<string, unknown>) {
    act(() => {
      MockWebSocket.instances[0].dispatch('message', {
        data: JSON.stringify({ event_type: 'task_dates_updated', payload }),
      });
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    // @ts-expect-error — overriding WebSocket for the test environment
    globalThis.WebSocket = MockWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: 'tok', isAuthenticated: true });
    });
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: null, isAuthenticated: false });
    });
  });

  it('splices per-task deltas into the tasks cache without invalidating', () => {
    seedTasks();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch({
      count: 1,
      tasks: [
        {
          id: 't1',
          early_start: '2026-11-02',
          early_finish: '2026-11-12',
          late_start: '2026-11-05',
          late_finish: '2026-11-15',
          total_float: 0,
          free_float: 0,
          is_critical: true,
          planned_start: null,
          duration: 10,
        },
      ],
    });

    const cached = qc.getQueryData(['tasks', 'proj-1']) as Array<Record<string, unknown>>;
    const t1 = cached.find((t) => t.id === 't1')!;
    expect(t1.start).toBe('2026-11-02');
    expect(t1.finish).toBe('2026-11-12');
    expect(t1.isCritical).toBe(true);
    expect(t1.totalFloat).toBe(0);
    // Untouched task is left intact (same reference identity is not required, value is).
    const t2 = cached.find((t) => t.id === 't2')!;
    expect(t2.start).toBe('2026-10-16');
    // No re-fetch of the tasks query — the whole point of the delta event.
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it('invalidates the tasks query on a truncated payload', () => {
    seedTasks();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch({ count: 1287, truncated: true });
    act(() => {
      vi.advanceTimersByTime(400); // flush the trailing-debounce window
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });
});

// Wave-2 broadcast-check (#835) — backend emits these on commit but the client
// had no handler, so collaborators saw stale data until reload.
describe('useProjectWebSocket — wave-2 missing handlers (#835)', () => {
  const originalWebSocket = globalThis.WebSocket;
  let qc: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    // @ts-expect-error — overriding WebSocket for the test environment
    globalThis.WebSocket = MockWebSocket;
    act(() => {
      useAuthStore.setState({
        accessToken: 'tok-abc',
        isAuthenticated: true,
      });
    });
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    act(() => {
      useAuthStore.setState({
        accessToken: null,
        isAuthenticated: false,
      });
    });
  });

  function dispatch(eventType: string, payload: Record<string, unknown>) {
    act(() => {
      MockWebSocket.instances[0].dispatch('message', {
        data: JSON.stringify({ event_type: eventType, payload }),
      });
    });
  }

  function flushDebounce() {
    act(() => {
      vi.advanceTimersByTime(400);
    });
  }

  it.each(['task_link_created', 'task_link_updated', 'task_link_deleted'])(
    'invalidates the task-links query on %s',
    (eventType) => {
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

      dispatch(eventType, { task_id: 'task-9' });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-links', 'task-9'] });
    },
  );

  it('invalidates the tasks feed and My Work on suggestion_created', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('suggestion_created', { task_id: 'task-9', suggestion_id: 's-1' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me', 'work'] });
    flushDebounce();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it.each(['api_token_minted', 'api_token_revoked'])(
    'invalidates the api-tokens query on %s',
    (eventType) => {
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

      dispatch(eventType, { id: 'tok-1' });

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['api-tokens', 'project', 'proj-1'],
      });
    },
  );

  it('invalidates the customFields query on project_custom_fields_updated', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('project_custom_fields_updated', { action: 'created' });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['customFields', 'proj-1'] });
  });

  // #837 — reaction/ack broadcasts refetch the task-comments cache (inline render).
  it.each([
    'task_comment_reaction_added',
    'task_comment_reaction_removed',
    'task_comment_ack_changed',
  ])('invalidates the task-comments query on %s', (eventType) => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch(eventType, { task_id: 'task-7', comment_id: 'c-1' });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-comments', 'task-7'] });
  });

  // #927 (ADR-0078) — a facet/role reassign broadcasts team_member_changed.
  // The roster query is keyed by team id (the payload carries team_id, not
  // project_id), so a second admin viewing the Team tab sees it live.
  it('invalidates the team roster on team_member_changed (keyed by team_id)', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('team_member_changed', {
      team_id: 'team-1',
      membership_id: 'm-1',
      is_scrum_master: true,
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['team-members', 'team-1'] });
  });

  it('does not invalidate the roster on team_member_changed without a team_id', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('team_member_changed', { membership_id: 'm-1' });

    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: ['team-members', undefined],
    });
  });
});
