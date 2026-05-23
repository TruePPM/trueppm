import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Silence jsdom's VirtualConsole noise from unmocked apiClient XHRs. When a
// component leaks a request after unmount (TanStack Query polling, deferred
// refetch), jsdom logs an AggregateError per attempt via console.error — at
// volume this floods the worker's stderr IPC pipe and trips EPIPE, killing
// vitest's fork even with dangerouslyIgnoreUnhandledErrors. VirtualConsole
// passes the stack as the first arg (a string) — filter by the exact jsdom
// XHR signature so unrelated console.error calls still surface.
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const first = args[0];
  if (
    typeof first === 'string' &&
    first.startsWith('Error: AggregateError') &&
    /jsdom[\\/].+xhr/.test(first)
  ) {
    return;
  }
  originalConsoleError(...args);
};

// Explicit cleanup after every test — @testing-library/react auto-registers
// afterEach(cleanup) per module, but in singleFork mode (all files share one
// Node process) the auto-registration can misfire between test files, leaving
// stale DOM nodes that cause "Found multiple elements" errors.  Calling it
// explicitly here in the global setup guarantees it always runs.
afterEach(cleanup);

// Stub Web Worker — jsdom does not implement the Worker API.
// useDragCpm spawns a Worker only when ganttApi is non-null; in tests ganttApi
// is always null (SVAR is mocked), so the worker is never instantiated.
// The stub prevents the "Worker is not defined" ReferenceError during module load.
class WorkerStub {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  postMessage(_data: unknown): void {}
  terminate(): void {}
}
(globalThis as unknown as Record<string, unknown>).Worker = WorkerStub;

// Stub WebSocket — jsdom does not implement WebSocket.
// useProjectWebSocket only opens a socket when projectId and accessToken are
// both present; in App-level tests neither is set, so the stub is never
// instantiated, but module load still requires the global to exist.
class WebSocketStub {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = WebSocketStub.OPEN;
  constructor(_url: string) {}
  addEventListener(_type: string, _handler: unknown): void {}
  removeEventListener(_type: string, _handler: unknown): void {}
  close(): void {}
}
(globalThis as unknown as Record<string, unknown>).WebSocket = WebSocketStub;

// Required by components that use responsive design / media queries.
// `min-width` queries default to `matches: true` so `useBreakpoint` reports
// the `lg` tier — the reference layout that existing tests were written
// against (#568). Tests that need a narrower viewport can override
// `window.matchMedia` per-test via `vi.stubGlobal('matchMedia', …)`.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: /^\(min-width:/.test(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
