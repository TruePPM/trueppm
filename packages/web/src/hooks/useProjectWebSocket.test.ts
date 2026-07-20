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
import { useSchedulerStore } from '@/stores/schedulerStore';
import { useTaskRunStore } from '@/stores/taskRunStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useWsConnectionStore } from '@/stores/wsConnectionStore';
import type { Task } from '@/types';

// The hook now mints a single-use ticket (ADR-0141) before opening the socket.
// These tests exercise event handling, not the ticket round-trip, so mock
// fetchWsTicket with a *synchronous* thenable: it resolves in-line so the socket
// is created during connect() and the existing synchronous assertions still hold.
// The real async ticket flow is covered in wsTicket.test.ts + the ticket-flow
// test below.
//
// `wsTicketControl.mode` lets a test flip the mint from resolve → reject so the
// `.catch()` failure branch (session-expired vs back-off-and-retry) can be
// exercised synchronously. It defaults to 'success' and every describe resets to
// it, so the existing synchronous-resolve behavior is unchanged.
const wsTicketControl = vi.hoisted(() => ({ mode: 'success' as 'success' | 'reject' }));
vi.mock('@/api/wsTicket', () => ({
  fetchWsTicket: () => ({
    then(onFulfilled: (t: string) => void) {
      if (wsTicketControl.mode === 'success') onFulfilled('test-ticket');
      return this;
    },
    catch(onRejected: (e: unknown) => void) {
      if (wsTicketControl.mode === 'reject') onRejected(new Error('mint failed'));
      return this;
    },
  }),
}));

// Membership events toast the current user when their own role changes (#2039).
// Hoisted so the vi.mock factory (itself hoisted) can close over it.
const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warm: vi.fn(),
}));
vi.mock('@/components/Toast/toast', () => ({ toast: toastMock }));

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

  it('invalidates poker and the sprint backlog on poker_session_updated (#863)', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchEvent('poker_session_updated');
    flushDebounce();

    // The payload carries no sprint_id, so every mounted poker query is invalidated;
    // a commit also writes story_points, so the planning backlog refreshes.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['poker'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sprint-backlog', 'proj-1'] });
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

  // #37 (CodeQL js/unvalidated-dynamic-method-call): event_type is read straight
  // off the wire frame and used to index the handler table. A frame whose
  // event_type collides with an Object.prototype key must never resolve to a
  // prototype method and be invoked — the Object.hasOwn guard makes it an inert
  // no-op instead of a TypeError (__proto__) or a stray prototype-method call
  // (hasOwnProperty / toString / valueOf / constructor).
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])(
    'ignores a frame whose event_type is the prototype key %p (no throw, no dispatch)',
    (protoKey) => {
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });
      flushDebounce();
      const callsBefore = invalidateSpy.mock.calls.length;

      expect(() => dispatchEvent(protoKey)).not.toThrow();
      flushDebounce();

      expect(invalidateSpy.mock.calls.length).toBe(callsBefore);
    },
  );

  it('invalidates the decisions list and task-notes on task_note_decision_toggled (#748)', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    act(() => {
      MockWebSocket.instances[0].dispatch('message', {
        data: JSON.stringify({
          event_type: 'task_note_decision_toggled',
          payload: { id: 'note-1', task_id: 'task-1', decision: true },
        }),
      });
    });
    flushDebounce();

    // The toggle flips a per-task note chip AND re-sorts the project Decisions list.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-notes', 'task-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['decisions', 'proj-1'] });
  });

  it('does not invalidate the decisions list for a plain task_note_pinned event (#748)', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    act(() => {
      MockWebSocket.instances[0].dispatch('message', {
        data: JSON.stringify({
          event_type: 'task_note_pinned',
          payload: { id: 'note-1', task_id: 'task-1', pinned: true },
        }),
      });
    });
    flushDebounce();

    // Pin still refreshes the per-task notes, but the Decisions list is decision-only.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-notes', 'task-1'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['decisions', 'proj-1'] });
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

  // ADR-0113 — a sprint's velocity contribution changes on sprint state events
  // (close adds a data point, exclude_from_velocity drops one). A peer with the
  // velocity band or delivery forecast open must refetch, matching the local
  // mutation in useSprints — otherwise they hold a stale band until refresh.
  it('invalidates velocity and forecast on sprint_updated (exclude_from_velocity peer refresh)', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchEvent('sprint_updated');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sprints', 'proj-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['project', 'proj-1', 'velocity'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['project', 'proj-1', 'forecast'],
    });
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

  // ADR-0118 amend (#1130/#1131/#1132) — a peer reordering the demo list, setting
  // a presenter/note, or flagging a story for backlog must refetch the consolidated
  // Sprint Review read so co-viewers don't drift until a manual refresh.
  it.each([
    'demo_toggled',
    'demo_reordered',
    'demo_presenter_set',
    'review_note_set',
    'flagged_for_backlog',
  ])('invalidates the targeted outcome read on %s when the payload carries sprint_id', (evt) => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    act(() => {
      MockWebSocket.instances[0].dispatch('message', {
        data: JSON.stringify({ event_type: evt, payload: { sprint_id: 's1' } }),
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sprint', 's1', 'outcome'] });
  });

  it('falls back to all outcome queries on a review-curation event with no sprint_id', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    act(() => {
      MockWebSocket.instances[0].dispatch('message', {
        data: JSON.stringify({ event_type: 'demo_reordered', payload: {} }),
      });
    });

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

  // --- ADR-0152 (#327): task_updated delta — self-echo + version dedup ---

  function dispatchTaskUpdated(payload: Record<string, unknown>) {
    act(() => {
      MockWebSocket.instances[0].dispatch('message', {
        data: JSON.stringify({ event_type: 'task_updated', payload }),
      });
    });
  }

  function tasksInvalidationCount(calls: unknown[][]): number {
    return calls.filter((call) => {
      const arg = call[0] as { queryKey?: unknown[] } | undefined;
      return Array.isArray(arg?.queryKey) && arg.queryKey[0] === 'tasks';
    }).length;
  }

  it('suppresses a self-echo task_updated (actor is the current user)', () => {
    qc.setQueryData(['current-user'], { id: 'me' });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchTaskUpdated({ id: 't1', actor_id: 'me', version: 5, changed_fields: ['status'] });
    flushDebounce();

    // The originating client already applied its optimistic update — no refetch.
    expect(tasksInvalidationCount(invalidateSpy.mock.calls)).toBe(0);
  });

  it('invalidates tasks on a remote-actor task_updated', () => {
    qc.setQueryData(['current-user'], { id: 'me' });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchTaskUpdated({
      id: 't1',
      actor_id: 'someone-else',
      version: 5,
      changed_fields: ['status'],
    });
    flushDebounce();

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it('ignores a duplicate/replayed task_updated at a version already observed', () => {
    qc.setQueryData(['current-user'], { id: 'me' });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchTaskUpdated({
      id: 't1',
      actor_id: 'someone-else',
      version: 7,
      changed_fields: ['status'],
    });
    flushDebounce();
    dispatchTaskUpdated({
      id: 't1',
      actor_id: 'someone-else',
      version: 7,
      changed_fields: ['status'],
    });
    flushDebounce();

    // First event invalidates; the replay at the same version is a no-op.
    expect(tasksInvalidationCount(invalidateSpy.mock.calls)).toBe(1);
  });

  // --- Drawer Activity feed freshness (#1867) ----------------------------

  function taskHistoryCalls(calls: unknown[][]): unknown[][] {
    return calls.filter((call) => {
      const arg = call[0] as { queryKey?: unknown[] } | undefined;
      return Array.isArray(arg?.queryKey) && arg.queryKey[0] === 'task-history';
    });
  }

  it('invalidates the per-task history key on a remote task_updated (#1867)', () => {
    qc.setQueryData(['current-user'], { id: 'me' });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchTaskUpdated({ id: 't1', actor_id: 'someone-else', version: 5 });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-history', 'proj-1', 't1'] });
  });

  it('skips the task-history invalidation for a duplicate/replayed task_updated', () => {
    qc.setQueryData(['current-user'], { id: 'me' });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchTaskUpdated({ id: 't1', actor_id: 'someone-else', version: 7 });
    dispatchTaskUpdated({ id: 't1', actor_id: 'someone-else', version: 7 });

    expect(taskHistoryCalls(invalidateSpy.mock.calls)).toHaveLength(1);
  });

  it('invalidates the per-task history key on task_created and task_deleted (#1867)', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    // dispatchEvent sends payload { id: 'dep-1' } — the broadcast's task id.
    dispatchEvent('task_created');
    dispatchEvent('task_deleted');

    const calls = taskHistoryCalls(invalidateSpy.mock.calls);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect((call[0] as { queryKey: unknown[] }).queryKey).toEqual([
        'task-history',
        'proj-1',
        'dep-1',
      ]);
    }
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

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['project-custom-fields', 'proj-1'],
    });
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

// #1264 / ADR-0160 Amendment B1 — the board activity panel goes live by
// invalidating ['board-activity', projectId] on the existing card-sync events,
// refetched through the already role-gated read API. No new WS event type.
describe('useProjectWebSocket — board activity feed live updates (#1264)', () => {
  const originalWebSocket = globalThis.WebSocket;
  let qc: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    // @ts-expect-error — overriding WebSocket for the test environment
    globalThis.WebSocket = MockWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: 'tok-abc', isAuthenticated: true });
    });
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: null, isAuthenticated: false });
    });
  });

  function dispatch(eventType: string, payload: Record<string, unknown> = {}) {
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

  function boardActivityInvalidationCount(calls: unknown[][]): number {
    return calls.filter((call) => {
      const arg = call[0] as { queryKey?: unknown[] } | undefined;
      return (
        Array.isArray(arg?.queryKey) &&
        arg.queryKey[0] === 'board-activity' &&
        arg.queryKey[1] === 'proj-1'
      );
    }).length;
  }

  it.each(['task_created', 'task_deleted'])(
    'invalidates the board activity feed on %s',
    (eventType) => {
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

      dispatch(eventType, { id: 't1' });
      flushDebounce();

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['board-activity', 'proj-1'] });
    },
  );

  it('invalidates the board activity feed on a remote-actor task_updated', () => {
    qc.setQueryData(['current-user'], { id: 'me' });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('task_updated', { id: 't1', actor_id: 'someone-else', version: 3 });
    flushDebounce();

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['board-activity', 'proj-1'] });
  });

  it('refetches the feed even on a self-echo task_updated (append-only audit log)', () => {
    // Unlike the tasks cache (which suppresses self-echo to protect an in-flight
    // optimistic edit), the activity feed has no optimistic state and should show
    // the originating user's own action — so it still refetches.
    qc.setQueryData(['current-user'], { id: 'me' });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('task_updated', { id: 't1', actor_id: 'me', version: 5 });
    flushDebounce();

    expect(boardActivityInvalidationCount(invalidateSpy.mock.calls)).toBe(1);
    // ...but the tasks cache is NOT refetched on a self-echo (optimistic update stands).
    const tasksCalls = invalidateSpy.mock.calls.filter((call) => {
      const arg = call[0] as { queryKey?: unknown[] } | undefined;
      return Array.isArray(arg?.queryKey) && arg.queryKey[0] === 'tasks';
    }).length;
    expect(tasksCalls).toBe(0);
  });

  it('does not refetch the feed for a duplicate/replayed task_updated', () => {
    qc.setQueryData(['current-user'], { id: 'me' });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('task_updated', { id: 't1', actor_id: 'someone-else', version: 7 });
    flushDebounce();
    dispatch('task_updated', { id: 't1', actor_id: 'someone-else', version: 7 });
    flushDebounce();

    // First event refetches the feed; the same-version replay is a no-op.
    expect(boardActivityInvalidationCount(invalidateSpy.mock.calls)).toBe(1);
  });

  it('invalidates the board activity feed on task_comment_created', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('task_comment_created', { task_id: 't1', comment_id: 'c1' });
    flushDebounce();

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['board-activity', 'proj-1'] });
  });

  it.each(['task_comment_updated', 'task_comment_deleted', 'task_comment_reaction_added'])(
    'does not invalidate the feed on %s (no new feed row)',
    (eventType) => {
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

      dispatch(eventType, { task_id: 't1', comment_id: 'c1' });
      flushDebounce();

      expect(boardActivityInvalidationCount(invalidateSpy.mock.calls)).toBe(0);
    },
  );

  it('invalidates the board activity feed on sprint_scope_changed', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('sprint_scope_changed', { sprint_id: 's1', task_id: 't1' });
    flushDebounce();

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['board-activity', 'proj-1'] });
  });

  it('coalesces a burst of card mutations into a single feed invalidation', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('task_created', { id: 't1' });
    dispatch('task_updated', { id: 't2', actor_id: 'x', version: 1 });
    dispatch('task_deleted', { id: 't3' });

    // Nothing fires until the burst goes quiet.
    expect(boardActivityInvalidationCount(invalidateSpy.mock.calls)).toBe(0);
    flushDebounce();
    expect(boardActivityInvalidationCount(invalidateSpy.mock.calls)).toBe(1);
  });

  it('does not invalidate the feed for an unrelated event', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('board_config_updated', {});
    flushDebounce();

    expect(boardActivityInvalidationCount(invalidateSpy.mock.calls)).toBe(0);
  });
});

// Wave-2 broadcast-check (#1323) — cross-project dep accept/reject, the suggestion
// decline/revoke lifecycle, and the slip-conflict acknowledge had no client handler;
// task_duration_changed must stay a deliberate no-op (the delta arrives via
// task_updated with ADR-0152 self-echo suppression, so a tasks invalidate here would
// clobber the editor's in-flight optimistic edit).
describe('useProjectWebSocket — wave-2 missing handlers (#1323)', () => {
  const originalWebSocket = globalThis.WebSocket;
  let qc: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    // @ts-expect-error — overriding WebSocket for the test environment
    globalThis.WebSocket = MockWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: 'tok-abc', isAuthenticated: true });
    });
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: null, isAuthenticated: false });
    });
  });

  function dispatch(eventType: string, payload: Record<string, unknown> = {}) {
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

  it.each(['dependency_accepted', 'dependency_rejected'])(
    'invalidates dependencies and tasks on %s (cross-project edge resolution)',
    (eventType) => {
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

      dispatch(eventType, { id: 'dep-1' });
      flushDebounce();

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dependencies', 'proj-1'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
    },
  );

  it.each(['suggestion_declined', 'suggestion_revoked'])(
    'invalidates the tasks feed and My Work on %s',
    (eventType) => {
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

      dispatch(eventType, { id: 's-1', task_id: 'task-9' });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me', 'work'] });
      flushDebounce();
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
    },
  );

  it.each(['slip_conflict_acknowledged', 'slip_conflicts_updated'])(
    'invalidates the slip-conflicts query on %s',
    (eventType) => {
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

      dispatch(eventType, { id: 'conflict-1' });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['slip-conflicts'] });
    },
  );

  it('invalidates the named sprint retro on sprint_retro_updated', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('sprint_retro_updated', { sprint_id: 'sprint-7' });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sprint', 'sprint-7', 'retro'] });
  });

  it('ignores a sprint_retro_updated event with no sprint_id', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('sprint_retro_updated', {});

    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: ['sprint', undefined, 'retro'],
    });
  });

  it('does NOT invalidate tasks on task_duration_changed (covered by task_updated)', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('task_duration_changed', { task_id: 'task-9', new_duration: 5 });
    flushDebounce();

    // Re-invalidating here would clobber the editor's optimistic edit (ADR-0152);
    // the task_updated event in the same commit batch is the sole tasks-cache driver.
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });
});

describe('useProjectWebSocket — event replay sequence handling (ADR-0236, #321)', () => {
  const originalWebSocket = globalThis.WebSocket;
  let qc: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    // @ts-expect-error — overriding WebSocket for the test environment
    globalThis.WebSocket = MockWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: 'tok-abc', isAuthenticated: true });
    });
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: null, isAuthenticated: false });
    });
  });

  function dispatch(payloadObj: Record<string, unknown>) {
    act(() => {
      MockWebSocket.instances[0].dispatch('message', { data: JSON.stringify(payloadObj) });
    });
  }

  function flushDebounce() {
    act(() => {
      vi.advanceTimersByTime(400);
    });
  }

  it('fresh connect omits &since (nothing processed yet)', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });
    expect(MockWebSocket.instances[0].url).not.toContain('since=');
    expect(MockWebSocket.instances[0].url).toContain('ticket=test-ticket');
  });

  it('reconnect carries &since=<highest seq processed>', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    // Process a persisted (seq-bearing) event.
    dispatch({ event_type: 'task_created', payload: { id: 't1' }, seq: 7 });
    flushDebounce();

    // Trigger a retryable close → backoff reconnect.
    act(() => {
      MockWebSocket.instances[0].dispatch('close', { code: 1006 });
    });
    act(() => {
      vi.advanceTimersByTime(1000); // first backoff window
    });

    expect(MockWebSocket.instances.length).toBe(2);
    expect(MockWebSocket.instances[1].url).toContain('&since=7');
  });

  it('drops an event whose seq was already processed (replay↔live dedup)', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    // Advance the cursor to 5 via a task event.
    dispatch({ event_type: 'task_created', payload: { id: 't1' }, seq: 5 });
    flushDebounce();

    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    // A stale/duplicate event at seq <= 5 must be dropped entirely.
    dispatch({ event_type: 'dependency_created', payload: { id: 'd1' }, seq: 3 });
    flushDebounce();

    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['dependencies', 'proj-1'] });
  });

  it('does not gate ephemeral frames without a seq, and they do not advance the cursor', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch({ event_type: 'task_created', payload: { id: 't1' }, seq: 9 });
    flushDebounce();
    // A seq-less presence frame processes normally and must NOT bump the cursor.
    dispatch({ event_type: 'presence_join', payload: { user_id: 'u2', display_name: 'Bo' } });

    act(() => {
      MockWebSocket.instances[0].dispatch('close', { code: 1006 });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // Cursor stayed at 9 (presence did not advance it).
    expect(MockWebSocket.instances[1].url).toContain('&since=9');
  });

  it('resync_required refetches project caches and does not throw', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    dispatch({ event_type: 'resync_required', payload: { latest_seq: 42 }, seq: null });

    // The projects list is refetched, plus a project-scoped predicate sweep.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
    const sawPredicateSweep = invalidateSpy.mock.calls.some(
      (call) => typeof call[0]?.predicate === 'function',
    );
    expect(sawPredicateSweep).toBe(true);
  });

  it('after resync, the next reconnect requests since=latest_seq from the frame', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch({ event_type: 'resync_required', payload: { latest_seq: 42 }, seq: null });

    act(() => {
      MockWebSocket.instances[0].dispatch('close', { code: 1006 });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(MockWebSocket.instances[1].url).toContain('&since=42');
  });
});

// Recalculating-badge lifecycle (#1976) — the shell "Recalculating…" badge is
// driven by schedulerStore.isRecalculating. It must clear on ANY completed
// scheduling.recalculate run, even one that produced no finish date (empty
// project, program escalation), or the badge spins forever.
describe('useProjectWebSocket — recalculating badge lifecycle (#1976)', () => {
  const originalWebSocket = globalThis.WebSocket;
  let qc: QueryClient;

  function dispatch(eventType: string, payload: Record<string, unknown>) {
    act(() => {
      MockWebSocket.instances[0].dispatch('message', {
        data: JSON.stringify({ event_type: eventType, payload }),
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
      useSchedulerStore.setState({ isRecalculating: false, cpmError: null, recalculatedAt: null });
      useTaskRunStore.setState({ runs: {} });
    });
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: null, isAuthenticated: false });
      useSchedulerStore.setState({ isRecalculating: false, cpmError: null, recalculatedAt: null });
      useTaskRunStore.setState({ runs: {} });
    });
  });

  it('sets isRecalculating on a scheduling.recalculate task_run_started', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('task_run_started', {
      task_run_id: 'run-1',
      task_name: 'scheduling.recalculate',
      project_id: 'proj-1',
    });

    expect(useSchedulerStore.getState().isRecalculating).toBe(true);
  });

  it('clears isRecalculating and updates the finish pill when the run yields a date', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('task_run_started', {
      task_run_id: 'run-1',
      task_name: 'scheduling.recalculate',
      project_id: 'proj-1',
    });
    dispatch('task_run_completed', {
      task_run_id: 'run-1',
      result_summary: { project_finish: '2026-09-29T00:00:00Z' },
    });

    expect(useSchedulerStore.getState().isRecalculating).toBe(false);
    expect(useSchedulerStore.getState().recalculatedAt).toBe('2026-09-29T00:00:00Z');
  });

  it('clears isRecalculating when a scheduling run completes with no finish date (#1976)', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('task_run_started', {
      task_run_id: 'run-1',
      task_name: 'scheduling.recalculate',
      project_id: 'proj-1',
    });
    // Successful recalc that produced no dates (empty project / program escalation):
    // result_summary is null. Previously this left the badge spinning forever.
    dispatch('task_run_completed', { task_run_id: 'run-1', result_summary: null });

    expect(useSchedulerStore.getState().isRecalculating).toBe(false);
  });

  it('leaves isRecalculating untouched for a non-scheduling run completing with no result', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    // A scheduling run is in flight…
    dispatch('task_run_started', {
      task_run_id: 'sched-1',
      task_name: 'scheduling.recalculate',
      project_id: 'proj-1',
    });
    // …an unrelated background run completes with a null summary. It must NOT
    // clear the scheduling spinner.
    dispatch('task_run_started', {
      task_run_id: 'other-1',
      task_name: 'export.pdf',
      project_id: 'proj-1',
    });
    dispatch('task_run_completed', { task_run_id: 'other-1', result_summary: null });

    expect(useSchedulerStore.getState().isRecalculating).toBe(true);
  });
});

describe('useProjectWebSocket — membership events refresh self-role (#2039)', () => {
  const originalWebSocket = globalThis.WebSocket;
  let qc: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    toastMock.info.mockClear();
    // @ts-expect-error — overriding WebSocket for the test environment
    globalThis.WebSocket = MockWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: 'tok-abc', isAuthenticated: true });
    });
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: null, isAuthenticated: false });
    });
  });

  function dispatch(eventType: string, payload: Record<string, unknown> = {}) {
    act(() => {
      MockWebSocket.instances[0].dispatch('message', {
        data: JSON.stringify({ event_type: eventType, payload }),
      });
    });
  }

  function selfRoleInvalidations(calls: unknown[][]): number {
    return calls.filter((call) => {
      const arg = call[0] as { queryKey?: unknown[] } | undefined;
      return (
        Array.isArray(arg?.queryKey) &&
        arg.queryKey[0] === 'project-member-self' &&
        arg.queryKey[1] === 'proj-1'
      );
    }).length;
  }

  it.each(['member_added', 'member_role_changed', 'member_removed'])(
    'invalidates the caller self-role query on %s',
    (eventType) => {
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

      dispatch(eventType, { membership_id: 'm1', user_id: 'someone-else' });

      expect(selfRoleInvalidations(invalidateSpy.mock.calls)).toBe(1);
    },
  );

  it('toasts when the current user is the one whose role changed', () => {
    qc.setQueryData(['current-user'], { id: 'me' });
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('member_role_changed', { membership_id: 'm1', user_id: 'me', role: 100 });

    expect(toastMock.info).toHaveBeenCalledTimes(1);
  });

  it('does not toast when a different member had their role changed', () => {
    qc.setQueryData(['current-user'], { id: 'me' });
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('member_role_changed', { membership_id: 'm1', user_id: 'other', role: 100 });

    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it('does not toast for member_added/member_removed even when it targets the current user', () => {
    qc.setQueryData(['current-user'], { id: 'me' });
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('member_added', { membership_id: 'm1', user_id: 'me' });
    dispatch('member_removed', { membership_id: 'm1', user_id: 'me' });

    expect(toastMock.info).not.toHaveBeenCalled();
  });
});

// --- Task-run progress lifecycle → taskRunStore side effects --------------
// The task_run_* events feed the global TaskRunIndicator via taskRunStore.
// These assert the concrete store mutations (and the scheduling-integration
// branches) rather than just query invalidations.
describe('useProjectWebSocket — task-run lifecycle store effects', () => {
  const originalWebSocket = globalThis.WebSocket;
  let qc: QueryClient;

  function dispatch(eventType: string, payload: Record<string, unknown>) {
    act(() => {
      MockWebSocket.instances[0].dispatch('message', {
        data: JSON.stringify({ event_type: eventType, payload }),
      });
    });
  }

  beforeEach(() => {
    MockWebSocket.instances = [];
    // @ts-expect-error — overriding WebSocket for the test environment
    globalThis.WebSocket = MockWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: 'tok', isAuthenticated: true });
      useSchedulerStore.setState({ isRecalculating: false, cpmError: null, recalculatedAt: null });
      useTaskRunStore.setState({ runs: {}, activeCount: 0 });
    });
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: null, isAuthenticated: false });
      useSchedulerStore.setState({ isRecalculating: false, cpmError: null, recalculatedAt: null });
      useTaskRunStore.setState({ runs: {}, activeCount: 0 });
    });
  });

  it('adds a run to the store on task_run_started with pct 0 and running status', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('task_run_started', {
      task_run_id: 'run-1',
      task_name: 'export.pdf',
      project_id: 'proj-1',
    });

    const run = useTaskRunStore.getState().runs['run-1'];
    expect(run).toMatchObject({ taskRunId: 'run-1', taskName: 'export.pdf', status: 'running', pct: 0 });
    expect(run.projectId).toBe('proj-1');
    // A non-scheduling run must NOT flip the recalculating badge.
    expect(useSchedulerStore.getState().isRecalculating).toBe(false);
  });

  it('coerces a null project_id to null on task_run_started', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('task_run_started', {
      task_run_id: 'run-2',
      task_name: 'export.pdf',
      project_id: null,
    });

    expect(useTaskRunStore.getState().runs['run-2'].projectId).toBeNull();
  });

  it('updates progress pct/msg on task_run_progress for a known run', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('task_run_started', { task_run_id: 'r', task_name: 'export.pdf', project_id: 'proj-1' });
    dispatch('task_run_progress', { task_run_id: 'r', pct: 42, msg: 'halfway' });

    const run = useTaskRunStore.getState().runs['r'];
    expect(run.pct).toBe(42);
    expect(run.msg).toBe('halfway');
  });

  it('defaults pct to 0 and msg to empty when task_run_progress carries wrong types', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('task_run_started', { task_run_id: 'r', task_name: 'export.pdf', project_id: 'proj-1' });
    // pct/msg present but wrong types → the type-guards fall back to defaults.
    dispatch('task_run_progress', { task_run_id: 'r', pct: 'nope', msg: 99 });

    const run = useTaskRunStore.getState().runs['r'];
    expect(run.pct).toBe(0);
    expect(run.msg).toBe('');
  });

  it('marks a run failed and records the error detail on task_run_failed', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('task_run_started', { task_run_id: 'r', task_name: 'export.pdf', project_id: 'proj-1' });
    dispatch('task_run_failed', { task_run_id: 'r', error_detail: 'boom' });

    const run = useTaskRunStore.getState().runs['r'];
    expect(run.status).toBe('failed');
    expect(run.msg).toBe('boom');
    // A non-scheduling failure must not set CPM error state.
    expect(useSchedulerStore.getState().cpmError).toBeNull();
  });

  it('sets CPM error state when the failed run was the scheduling recalculate', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('task_run_started', {
      task_run_id: 'r',
      task_name: 'scheduling.recalculate',
      project_id: 'proj-1',
    });
    dispatch('task_run_failed', { task_run_id: 'r' }); // no error_detail → '' default

    expect(useTaskRunStore.getState().runs['r'].status).toBe('failed');
    expect(useSchedulerStore.getState().cpmError).toEqual({ error: 'internal_error', cycle: [] });
  });

  it('marks a run cancelled on task_run_cancelled', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('task_run_started', { task_run_id: 'r', task_name: 'export.pdf', project_id: 'proj-1' });
    dispatch('task_run_cancelled', { task_run_id: 'r' });

    expect(useTaskRunStore.getState().runs['r'].status).toBe('cancelled');
  });
});

// --- Presence, CPM compat, and CPM error handlers -------------------------
describe('useProjectWebSocket — presence and CPM handlers', () => {
  const originalWebSocket = globalThis.WebSocket;
  let qc: QueryClient;

  function dispatch(eventType: string, payload: Record<string, unknown>) {
    act(() => {
      MockWebSocket.instances[0].dispatch('message', {
        data: JSON.stringify({ event_type: eventType, payload }),
      });
    });
  }

  beforeEach(() => {
    MockWebSocket.instances = [];
    // @ts-expect-error — overriding WebSocket for the test environment
    globalThis.WebSocket = MockWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: 'tok', isAuthenticated: true });
      useSchedulerStore.setState({ isRecalculating: true, cpmError: null, recalculatedAt: null });
      usePresenceStore.setState({ users: {} });
    });
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: null, isAuthenticated: false });
      useSchedulerStore.setState({ isRecalculating: false, cpmError: null, recalculatedAt: null });
      usePresenceStore.setState({ users: {} });
    });
  });

  it('adds a presence user with the supplied display_name on presence_join', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('presence_join', { user_id: 'u1', display_name: 'Ada' });

    expect(usePresenceStore.getState().users['u1']).toEqual({ user_id: 'u1', display_name: 'Ada' });
  });

  it('falls back to the user_id as display_name when presence_join omits it', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('presence_join', { user_id: 'u2' });

    expect(usePresenceStore.getState().users['u2'].display_name).toBe('u2');
  });

  it('removes a presence user on presence_leave', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('presence_join', { user_id: 'u1', display_name: 'Ada' });
    dispatch('presence_leave', { user_id: 'u1' });

    expect(usePresenceStore.getState().users['u1']).toBeUndefined();
  });

  it('sets the CPM error from the payload and clears the recalculating badge on cpm_error', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('cpm_error', { error: 'cyclic_dependency' });

    expect(useSchedulerStore.getState().cpmError).toEqual({ error: 'cyclic_dependency', cycle: [] });
    expect(useSchedulerStore.getState().isRecalculating).toBe(false);
  });

  it('defaults the CPM error to timeout when cpm_error omits an error string', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('cpm_error', {});

    expect(useSchedulerStore.getState().cpmError).toEqual({ error: 'timeout', cycle: [] });
  });

  it('records the project finish and refreshes shellStats on the cpm_complete compat event', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('cpm_complete', { project_finish: '2026-12-01T00:00:00Z' });

    expect(useSchedulerStore.getState().recalculatedAt).toBe('2026-12-01T00:00:00Z');
    expect(useSchedulerStore.getState().isRecalculating).toBe(false);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['shellStats', 'proj-1'] });
    // The coarse compat event must NOT invalidate the tasks cache (ADR-0091).
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it('falls back to a generated timestamp when cpm_complete omits project_finish', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('cpm_complete', {});

    // A non-string finish → the handler stamps an ISO 'now'. Just assert it set *something*.
    expect(typeof useSchedulerStore.getState().recalculatedAt).toBe('string');
    expect(useSchedulerStore.getState().recalculatedAt).not.toBeNull();
  });
});

// --- Remaining invalidation handlers (baselines, bulk, risks, attachments,
//     retro board, assignments, mention groups, board views) ---------------
describe('useProjectWebSocket — remaining invalidation handlers', () => {
  const originalWebSocket = globalThis.WebSocket;
  let qc: QueryClient;

  function dispatch(eventType: string, payload: Record<string, unknown> = {}) {
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

  it('invalidates only baselines on baseline_created (no task overlay change)', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('baseline_created', { id: 'b1' });
    flushDebounce();

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['baselines', 'proj-1'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it.each(['baseline_activated', 'baseline_deleted'])(
    'invalidates baselines AND tasks on %s (active-baseline overlay changed)',
    (eventType) => {
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

      dispatch(eventType, { id: 'b1' });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['baselines', 'proj-1'] });
      flushDebounce();
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
    },
  );

  it.each(['tasks_reordered', 'tasks_restructured', 'tasks_bulk_mutated', 'phases_reordered', 'queue_reordered'])(
    'coalesces a tasks invalidation on the bulk-mutation event %s',
    (eventType) => {
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

      dispatch(eventType);
      flushDebounce();

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
    },
  );

  it('invalidates the product backlog and tasks on backlog_reranked', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('backlog_reranked');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['product-backlog', 'proj-1'] });
    flushDebounce();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it.each(['risk_created', 'risk_updated', 'risk_deleted', 'risks_imported'])(
    'invalidates the risks query on %s',
    (eventType) => {
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

      dispatch(eventType, { id: 'r1' });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['risks', 'proj-1'] });
    },
  );

  it('invalidates riskComments (not task-comments) on comment_created', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('comment_created', { id: 'c1' });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['riskComments', 'proj-1'] });
  });

  it.each(['task_attachment_created', 'task_attachment_deleted'])(
    'invalidates the task-attachments query keyed by task_id on %s',
    (eventType) => {
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

      dispatch(eventType, { task_id: 'task-3' });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-attachments', 'task-3'] });
    },
  );

  it('does not invalidate task-attachments when the event omits task_id', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('task_attachment_created', {});

    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['task-attachments', undefined] });
  });

  it.each(['retro_item_created', 'retro_item_updated', 'retro_item_deleted', 'retro_item_moved'])(
    'invalidates open retro-board queries via predicate on %s',
    (eventType) => {
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

      dispatch(eventType, { retro_id: 'retro-1' });

      const predicateCall = invalidateSpy.mock.calls.find(
        ([arg]) => typeof (arg as { predicate?: unknown }).predicate === 'function',
      );
      expect(predicateCall).toBeDefined();
      const { predicate } = predicateCall![0] as unknown as {
        predicate: (q: { queryKey: readonly unknown[] }) => boolean;
      };
      // The retro board cache is ['sprint', <id>, 'retro-board'].
      expect(predicate({ queryKey: ['sprint', 's1', 'retro-board'] })).toBe(true);
      expect(predicate({ queryKey: ['sprint', 's1', 'burndown'] })).toBe(false);
    },
  );

  it.each(['assignment_created', 'assignment_updated', 'assignment_deleted', 'roster_changed'])(
    'coalesces a tasks invalidation on the resource event %s',
    (eventType) => {
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

      dispatch(eventType);
      flushDebounce();

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
    },
  );

  it('invalidates the program mention-group cache for a program-scoped mention_group_changed', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('mention_group_changed', { scope: 'program', program_id: 'prog-9' });

    // Program-scoped groups ride project channels but target the program cache —
    // never the project key, which would spuriously refetch an unrelated list.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['program-mention-groups', 'prog-9'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['mention-groups', 'proj-1'] });
  });

  it('invalidates the project mention-group cache for a project-scoped mention_group_changed', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('mention_group_changed', { scope: 'project' });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['mention-groups', 'proj-1'] });
  });

  it('does nothing for a program-scoped mention_group_changed that omits program_id', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('mention_group_changed', { scope: 'program' });

    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['program-mention-groups', undefined] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['mention-groups', 'proj-1'] });
  });

  it.each(['board_view_created', 'board_view_updated', 'board_view_deleted'])(
    'invalidates the boardViews query on %s',
    (eventType) => {
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

      dispatch(eventType);

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['boardViews', 'proj-1'] });
    },
  );

  it('invalidates boardConfig on board_config_updated', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('board_config_updated');

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['boardConfig', 'proj-1'] });
  });

  it('actually matches the current project in the resync_required predicate', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    act(() => {
      MockWebSocket.instances[0].dispatch('message', {
        data: JSON.stringify({ event_type: 'resync_required', payload: {}, seq: null }),
      });
    });

    const predicateCall = invalidateSpy.mock.calls.find(
      ([arg]) => typeof (arg as { predicate?: unknown }).predicate === 'function',
    );
    expect(predicateCall).toBeDefined();
    const { predicate } = predicateCall![0] as unknown as {
      predicate: (q: { queryKey: readonly unknown[] }) => boolean;
    };
    // Any cache entry whose key includes the current project id is swept.
    expect(predicate({ queryKey: ['tasks', 'proj-1'] })).toBe(true);
    expect(predicate({ queryKey: ['tasks', 'other-proj'] })).toBe(false);
  });
});

// --- Connection-state machine (wsConnectionStore) side effects ------------
// The socket lifecycle callbacks drive the StatusBar connection pill (#643).
describe('useProjectWebSocket — connection-state lifecycle', () => {
  const originalWebSocket = globalThis.WebSocket;
  let qc: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    // @ts-expect-error — overriding WebSocket for the test environment
    globalThis.WebSocket = MockWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: 'tok', isAuthenticated: true, sessionExpired: false });
      useWsConnectionStore.setState({ state: 'connecting', reconnectAttempts: 0 });
    });
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: null, isAuthenticated: false, sessionExpired: false });
      useWsConnectionStore.setState({ state: 'connecting', reconnectAttempts: 0 });
    });
  });

  it('transitions to live when the socket open event fires', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    act(() => {
      MockWebSocket.instances[0].dispatch('open', {});
    });

    expect(useWsConnectionStore.getState().state).toBe('live');
    expect(useWsConnectionStore.getState().reconnectAttempts).toBe(0);
  });

  it('escalates reconnecting → stale over repeated retryable closes', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    // First retryable drop → reconnecting.
    act(() => {
      MockWebSocket.instances[0].dispatch('close', { code: 1006 });
    });
    expect(useWsConnectionStore.getState().state).toBe('reconnecting');

    // Drive the backoff reconnects and drop each socket again until STALE_AFTER_ATTEMPTS.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      MockWebSocket.instances[1].dispatch('close', { code: 1006 });
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => {
      MockWebSocket.instances[2].dispatch('close', { code: 1006 });
    });

    expect(useWsConnectionStore.getState().state).toBe('stale');
  });

  it('resets the connection state to connecting when the effect tears down (project change)', () => {
    const { rerender } = renderHook(({ pid }) => useProjectWebSocket(pid), {
      wrapper: makeWrapper(qc),
      initialProps: { pid: 'proj-1' as string | null },
    });

    act(() => {
      MockWebSocket.instances[0].dispatch('open', {});
    });
    expect(useWsConnectionStore.getState().state).toBe('live');

    // Changing the projectId re-runs the effect: cleanup resets to 'connecting'.
    rerender({ pid: 'proj-2' });
    expect(useWsConnectionStore.getState().state).toBe('connecting');
  });

  it('does not open a socket when there is no accessToken', () => {
    act(() => {
      useAuthStore.setState({ accessToken: null, isAuthenticated: false });
    });
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    expect(MockWebSocket.instances.length).toBe(0);
  });

  it('does not open a socket when projectId is null', () => {
    renderHook(() => useProjectWebSocket(null), { wrapper: makeWrapper(qc) });

    expect(MockWebSocket.instances.length).toBe(0);
  });

  it('closes and removes the message listener on unmount', () => {
    const { unmount } = renderHook(() => useProjectWebSocket('proj-1'), {
      wrapper: makeWrapper(qc),
    });
    const socket = MockWebSocket.instances[0];

    unmount();

    expect(socket.close).toHaveBeenCalled();
    // A late message after unmount must be inert (listener removed).
    expect(() =>
      socket.dispatch('message', {
        data: JSON.stringify({ event_type: 'task_created', payload: { id: 't1' } }),
      }),
    ).not.toThrow();
  });

  it('ignores a malformed (non-JSON) frame without throwing', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    expect(() =>
      act(() => {
        MockWebSocket.instances[0].dispatch('message', { data: 'not json {' });
      }),
    ).not.toThrow();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('ignores a retryable close that arrives after unmount', () => {
    const { unmount } = renderHook(() => useProjectWebSocket('proj-1'), {
      wrapper: makeWrapper(qc),
    });
    const socket = MockWebSocket.instances[0];
    unmount();
    act(() => {
      useWsConnectionStore.setState({ state: 'connecting', reconnectAttempts: 0 });
    });

    // The close listener is still attached, but the mountedRef guard makes it inert.
    act(() => {
      socket.dispatch('close', { code: 1006 });
    });
    // No reconnect scheduled, no escalation to reconnecting.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(MockWebSocket.instances.length).toBe(1);
    expect(useWsConnectionStore.getState().state).toBe('connecting');
  });

  it('clears a pending coalesced invalidation timer on unmount without flushing it', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { unmount } = renderHook(() => useProjectWebSocket('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    // Arm the trailing-debounce timer but unmount before it fires.
    act(() => {
      MockWebSocket.instances[0].dispatch('message', {
        data: JSON.stringify({ event_type: 'task_created', payload: { id: 't1' } }),
      });
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // The pending tasks invalidation was dropped, not flushed after teardown.
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });
});

// --- Payload type-guard branches (null/absent id fields) ------------------
describe('useProjectWebSocket — payload type-guard branches', () => {
  const originalWebSocket = globalThis.WebSocket;
  let qc: QueryClient;

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

  it('falls back to the project-wide task-history key when task_updated has no string id', () => {
    qc.setQueryData(['current-user'], { id: 'me' });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    // id absent → taskId resolves to null → project-scoped history key.
    dispatch('task_updated', { actor_id: 'someone-else', version: 3 });
    flushDebounce();

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-history', 'proj-1'] });
  });

  it('falls back to the project-wide task-history key when task_created has no string id', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('task_created', {});
    flushDebounce();

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task-history', 'proj-1'] });
  });

  it('still invalidates members but skips the self-role toast when member event has no user_id', () => {
    qc.setQueryData(['current-user'], { id: 'me' });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    // user_id absent → affectedUserId null branch: no toast, but members refresh.
    dispatch('member_role_changed', { membership_id: 'm1' });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['members', 'proj-1'] });
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it('invokes the burndown fallback predicate on sprint_scope_changed with no sprint_id', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('sprint_scope_changed', {});

    const predicateCall = invalidateSpy.mock.calls.find(
      ([arg]) => typeof (arg as { predicate?: unknown }).predicate === 'function',
    );
    const { predicate } = predicateCall![0] as unknown as {
      predicate: (q: { queryKey: readonly unknown[] }) => boolean;
    };
    expect(predicate({ queryKey: ['sprint', 's1', 'burndown'] })).toBe(true);
    expect(predicate({ queryKey: ['sprint', 's1', 'retro'] })).toBe(false);
  });

  it('invokes the outcome fallback predicate on a review-curation event with no sprint_id', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatch('review_note_set', {});

    const predicateCall = invalidateSpy.mock.calls.find(
      ([arg]) => typeof (arg as { predicate?: unknown }).predicate === 'function',
    );
    const { predicate } = predicateCall![0] as unknown as {
      predicate: (q: { queryKey: readonly unknown[] }) => boolean;
    };
    expect(predicate({ queryKey: ['sprint', 's1', 'outcome'] })).toBe(true);
    expect(predicate({ queryKey: ['sprint', 's1', 'burndown'] })).toBe(false);
  });
});

// --- Ticket-mint failure path (ADR-0141) ----------------------------------
// fetchWsTicket() is called on every (re)connect. When the mint rejects, the
// hook must NOT retry into a void if the session expired (mark failed, stop);
// otherwise it treats the failure like a transient drop (mark disconnected +
// schedule a backoff reconnect). This exercises the .catch() branch that the
// synchronous-resolve mock in the other suites never reaches (lines 882-891).
describe('useProjectWebSocket — ticket-mint failure path (ADR-0141)', () => {
  const originalWebSocket = globalThis.WebSocket;
  let qc: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    wsTicketControl.mode = 'reject';
    // @ts-expect-error — overriding WebSocket for the test environment
    globalThis.WebSocket = MockWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: 'tok', isAuthenticated: true, sessionExpired: false });
      useWsConnectionStore.setState({ state: 'connecting', reconnectAttempts: 0 });
    });
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    wsTicketControl.mode = 'success';
    act(() => {
      useAuthStore.setState({ accessToken: null, isAuthenticated: false, sessionExpired: false });
      useWsConnectionStore.setState({ state: 'connecting', reconnectAttempts: 0 });
    });
  });

  it('opens no socket and marks the connection reconnecting when the mint fails and the session is live', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    // The mint rejected before openSocket, so no WebSocket was constructed.
    expect(MockWebSocket.instances.length).toBe(0);
    // A live-session mint failure is treated as a transient drop.
    expect(useWsConnectionStore.getState().state).toBe('reconnecting');
    expect(useWsConnectionStore.getState().reconnectAttempts).toBe(1);
  });

  it('schedules a backoff reconnect that re-attempts the mint on a live-session failure', () => {
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    expect(useWsConnectionStore.getState().reconnectAttempts).toBe(1);

    // Advancing past the first backoff window fires scheduleReconnect → connect()
    // again; the mint rejects again, incrementing the attempt counter.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(useWsConnectionStore.getState().reconnectAttempts).toBe(2);

    // A third failed attempt escalates reconnecting → stale (STALE_AFTER_ATTEMPTS).
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(useWsConnectionStore.getState().reconnectAttempts).toBe(3);
    expect(useWsConnectionStore.getState().state).toBe('stale');
    // Still no socket ever opened — every mint rejected.
    expect(MockWebSocket.instances.length).toBe(0);
  });

  it('marks the connection failed (no reconnect) when the mint fails because the session expired', () => {
    act(() => {
      useAuthStore.setState({ sessionExpired: true });
    });
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    // An expired-session mint failure is terminal: mark failed, do not retry.
    expect(useWsConnectionStore.getState().state).toBe('failed');

    // No backoff reconnect was scheduled — advancing time does not re-attempt.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(useWsConnectionStore.getState().state).toBe('failed');
    expect(MockWebSocket.instances.length).toBe(0);
  });

  it('recovers and opens a socket once the mint starts succeeding again after a failure', () => {
    const { rerender } = renderHook(({ pid }) => useProjectWebSocket(pid), {
      wrapper: makeWrapper(qc),
      initialProps: { pid: 'proj-1' as string | null },
    });
    // First mount: mint rejected, no socket, reconnecting.
    expect(MockWebSocket.instances.length).toBe(0);
    expect(useWsConnectionStore.getState().state).toBe('reconnecting');

    // The mint recovers; a project change re-runs the effect and connects cleanly.
    wsTicketControl.mode = 'success';
    rerender({ pid: 'proj-2' });

    expect(MockWebSocket.instances.length).toBe(1);
    expect(MockWebSocket.instances[0].url).toContain('/ws/v1/projects/proj-2/');
    expect(MockWebSocket.instances[0].url).toContain('ticket=test-ticket');
  });
});
