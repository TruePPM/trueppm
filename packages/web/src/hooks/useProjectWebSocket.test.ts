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
        refreshToken: 'r-abc',
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
        refreshToken: null,
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
        refreshToken: 'r-abc',
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
        refreshToken: null,
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
