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

  it('invalidates dependencies and tasks on dependency_created', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchEvent('dependency_created');

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dependencies', 'proj-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it('invalidates dependencies and tasks on dependency_updated', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchEvent('dependency_updated');

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dependencies', 'proj-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it('invalidates dependencies and tasks on dependency_deleted', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchEvent('dependency_deleted');

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dependencies', 'proj-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it('does not invalidate dependencies for unrelated events', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useProjectWebSocket('proj-1'), { wrapper: makeWrapper(qc) });

    dispatchEvent('task_created');

    // task_created invalidates ['tasks'] only, never ['dependencies'].
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: ['dependencies', 'proj-1'],
    });
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
