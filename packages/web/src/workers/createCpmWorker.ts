/**
 * Factory for the CPM Web Worker.
 *
 * Isolated into its own module so tests can mock this file without triggering
 * Vite's worker bundling pipeline (which hangs in jsdom environments).
 *
 * Usage in production: imported by useDragCpm.
 * Usage in tests: vi.mock('@/workers/createCpmWorker') → returns a no-op stub.
 */
export function createCpmWorker(): Worker {
  // Two-step URL construction intentionally breaks Vite's `new Worker(new URL(...))`
  // static-analysis pattern so the worker bundling transform does not run during
  // Vitest's jsdom test collection (which has no browser runtime to serve workers).
  // Production Vite builds use the resolved URL at runtime — correct behaviour.
  const url = new URL('./cpmWorker.ts', import.meta.url);
  return new Worker(url, { type: 'module' });
}
