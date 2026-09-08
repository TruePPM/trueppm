/**
 * Factory for the CPM Web Worker.
 *
 * Isolated into its own module so tests can mock this file (`vi.mock(
 * '@/workers/createCpmWorker')`) rather than reach the real worker at all.
 *
 * THE `new Worker(new URL(...), ...)` CALL MUST STAY A SINGLE EXPRESSION.
 *
 * Vite recognises that exact shape and compiles the worker into its own bundled
 * chunk. Split across two statements it does not — but the `new URL('./x.ts',
 * import.meta.url)` half still matches Vite's asset plugin, so the build treats
 * `cpmWorker.ts` as a static ASSET and copies it verbatim, untranspiled. Under
 * the 4 KB inline limit that asset becomes a `data:video/mp2t;base64,…` URL (the
 * MIME the `.ts` extension resolves to — MPEG transport stream), and the browser
 * is handed raw TypeScript to run as a module worker. It cannot: the worker
 * fails to load, `onmessage` never fires, and `PreviewOverlay` renders no ghost
 * bars at all. Nothing surfaces — the failure is a worker-scoped load error with
 * no `onerror` handler, so the drag preview is simply, silently empty.
 *
 * That is what shipped. The split form was introduced to keep Vite's worker
 * transform out of Vitest's jsdom collection, and it did — along with keeping
 * the worker out of every production build since. The concern it was written
 * for no longer reproduces: `src/test/setup.ts` stubs the `Worker` global and
 * every suite that reaches this module either mocks it or renders with a null
 * engine, and the four worker-touching suites plus `ScheduleView` /
 * `ScheduleAriaOverlay` (308 tests) run clean against this form.
 *
 * The guard against a repeat is `e2e/schedule-drag-pull-in-preview.spec.ts`,
 * which asserts on ghost bars the worker has to produce.
 */
export function createCpmWorker(): Worker {
  return new Worker(new URL('./cpmWorker.ts', import.meta.url), { type: 'module' });
}
