import '@testing-library/jest-dom';
import nodeProcess from 'node:process';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Swallow jsdom XHR AggregateErrors from unmocked apiClient calls. Components
// that mount API-backed hooks under test occasionally fire requests after the
// test has finished (TanStack Query polling, deferred refetch); those promise
// rejections are orphaned, and under vitest workers > 1 the accumulated
// unhandled rejections crash a worker with ERR_IPC_CHANNEL_CLOSED, failing the
// suite even though every assertion passes. Filter narrowly: only network
// AggregateErrors from jsdom's XHR layer are silenced; real test rejections
// still propagate.
nodeProcess.on('unhandledRejection', (reason) => {
  if (
    reason instanceof Error &&
    reason.name === 'AggregateError' &&
    /jsdom[\\/].+xhr/.test(reason.stack ?? '')
  ) {
    return;
  }
  throw reason;
});

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
