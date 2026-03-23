import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

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

// Required by components that use responsive design / media queries
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
