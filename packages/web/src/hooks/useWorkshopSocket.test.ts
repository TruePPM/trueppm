/**
 * useWorkshopSocket unit tests — exercises the connect / message / close /
 * retry-with-backoff lifecycle and the disabled / no-token guards.
 *
 * The real `WebSocket` constructor is replaced with a mock that captures the
 * latest instance, so tests can drive open/message/close events synchronously.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWorkshopSocket } from './useWorkshopSocket';
import { useAuthStore } from '@/stores/authStore';

// The hook mints a single-use ticket (ADR-0141) before opening the socket. These
// lifecycle tests don't exercise the ticket round-trip, so mock fetchWsTicket
// with a synchronous thenable: it resolves in-line so the socket is created
// during connect() and the existing synchronous assertions still hold. The real
// async flow is covered in wsTicket.test.ts.
vi.mock('@/api/wsTicket', () => ({
  fetchWsTicket: () => ({
    then(onFulfilled: (t: string) => void) {
      onFulfilled('test-ticket');
      return this;
    },
    catch() {
      return this;
    },
  }),
}));

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
    this.dispatch('close', {});
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (e: unknown) => void) {
    (this.listeners[type] ||= []).push(cb);
  }

  dispatch(type: string, event: unknown) {
    (this.listeners[type] ?? []).forEach((cb) => {
      cb(event);
    });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.dispatch('open', {});
  }
}

describe('useWorkshopSocket', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    // @ts-expect-error — overriding WebSocket for the test environment
    globalThis.WebSocket = MockWebSocket;
    act(() => {
      useAuthStore.setState({
        accessToken: 'tok-abc',
        isAuthenticated: true,
      });
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    act(() => {
      useAuthStore.setState({
        accessToken: null,
        isAuthenticated: false,
      });
    });
    vi.useRealTimers();
  });

  it('does not open a socket when disabled', () => {
    renderHook(() => useWorkshopSocket('proj-1', false, vi.fn()));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('does not open a socket when projectId is missing', () => {
    renderHook(() => useWorkshopSocket(null, true, vi.fn()));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('does not open a socket when accessToken is missing', () => {
    act(() => {
      useAuthStore.setState({ accessToken: null, isAuthenticated: false });
    });
    renderHook(() => useWorkshopSocket('proj-1', true, vi.fn()));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('opens a socket with a ticket URL when enabled (ADR-0141)', () => {
    renderHook(() => useWorkshopSocket('proj-1', true, vi.fn()));
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain('/ws/v1/projects/proj-1/workshop/');
    // No JWT in the URL — the single-use ticket replaces ?token= (#818).
    expect(MockWebSocket.instances[0].url).toContain('ticket=test-ticket');
    expect(MockWebSocket.instances[0].url).not.toContain('token=');
  });

  it('forwards parsed messages to the onEvent callback', () => {
    const onEvent = vi.fn();
    renderHook(() => useWorkshopSocket('proj-1', true, onEvent));
    act(() => {
      MockWebSocket.instances[0].dispatch('message', {
        data: JSON.stringify({ type: 'cursor_move', user_id: 'u-1', x: 10, y: 20 }),
      });
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: 'cursor_move',
      user_id: 'u-1',
      x: 10,
      y: 20,
    });
  });

  it('silently ignores malformed JSON frames', () => {
    const onEvent = vi.fn();
    renderHook(() => useWorkshopSocket('proj-1', true, onEvent));
    act(() => {
      MockWebSocket.instances[0].dispatch('message', { data: '{not json' });
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('send() writes a JSON-encoded message when the socket is open', () => {
    const { result } = renderHook(() => useWorkshopSocket('proj-1', true, vi.fn()));
    act(() => {
      MockWebSocket.instances[0].open();
    });
    act(() => {
      result.current.send({ type: 'phase_rename', phase_id: 'p-1' });
    });
    expect(MockWebSocket.instances[0].send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'phase_rename', phase_id: 'p-1' }),
    );
  });

  it('send() is a no-op when the socket is not yet open', () => {
    const { result } = renderHook(() => useWorkshopSocket('proj-1', true, vi.fn()));
    act(() => {
      result.current.send({ type: 'phase_rename', phase_id: 'p-1' });
    });
    expect(MockWebSocket.instances[0].send).not.toHaveBeenCalled();
  });

  it('reconnects with backoff after the socket closes unexpectedly', () => {
    renderHook(() => useWorkshopSocket('proj-1', true, vi.fn()));
    expect(MockWebSocket.instances).toHaveLength(1);

    // Simulate server-side close without unmounting the hook.
    act(() => {
      MockWebSocket.instances[0].dispatch('close', {});
    });

    // The hook schedules a retry after 1s of backoff.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('closes the socket on unmount', () => {
    const { unmount } = renderHook(() => useWorkshopSocket('proj-1', true, vi.fn()));
    const ws = MockWebSocket.instances[0];
    unmount();
    expect(ws.close).toHaveBeenCalled();
  });

  it('does not reconnect after unmount even if a close event is queued', () => {
    const { unmount } = renderHook(() => useWorkshopSocket('proj-1', true, vi.fn()));
    expect(MockWebSocket.instances).toHaveLength(1);
    unmount();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    // Only the original instance should ever be created.
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
