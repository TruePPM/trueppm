/// <reference types="vitest" />
import { defineConfig, coverageConfigDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_SHA__: JSON.stringify('test-sha'),
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    // Suppress ONLY the known orphan-XHR / abort noise, not every unhandled
    // rejection. Components that mount API-backed hooks (TanStack Query, polling)
    // occasionally leak a rejection after the test has finished and the component
    // unmounted — an aborted/canceled in-flight request, or the ERR_IPC_CHANNEL_CLOSED
    // that surfaces when the fork tears down while an orphan XHR is still settling.
    // The previous `dangerouslyIgnoreUnhandledErrors: true` swallowed *all* of these
    // blanket, which also hid genuine unhandled rejections from product code.
    // Returning `false` ignores an error; returning `undefined` lets it fail the run,
    // so a real rejection outside these signatures still trips the suite.
    onUnhandledError(error) {
      // Build one haystack from every field the signature might live in: jsdom
      // reports its XHR AggregateError as an Error whose *message* is
      // "AggregateError" (name stays "Error") with the telltale frames in the
      // stack, so matching on `name` alone misses it — key on the combined text.
      const haystack = [
        typeof error?.name === 'string' ? error.name : '',
        typeof error?.message === 'string' ? error.message : '',
        typeof error?.stack === 'string' ? error.stack : '',
        String(error),
      ].join('\n');
      const isOrphanXhrNoise =
        // jsdom raises this from its XHR internals when a component leaks an
        // in-flight request after unmount (TanStack Query polling / deferred
        // refetch). Keyed on the same jsdom-XHR stack signature that
        // src/test/setup.ts filters on the VirtualConsole path — the only code
        // that produces this frame — so both routes for this one noise source
        // stay suppressed while genuine product-code rejections still fail the run.
        /jsdom[\\/].+xhr/i.test(haystack) ||
        /ERR_IPC_CHANNEL_CLOSED/.test(haystack) ||
        /\b(AbortError|CanceledError)\b/.test(haystack) ||
        /the operation was aborted|request aborted|canceled|cancelled/i.test(haystack);
      if (isOrphanXhrNoise) return false;
    },
    // Exclude Playwright E2E specs — they use playwright's own runner, not Vitest.
    exclude: ['e2e/**', 'node_modules/**'],
    globals: true,
    // Run all tests in a single forked process — avoids spawning multiple workers
    // that each inflate their own jsdom + RTL heap, which caused OOM on the default
    // multi-fork pool when the suite grew past ~20 test files.
    // Vitest 4 removed `poolOptions`; `fileParallelism: false` is the documented
    // replacement for the old `forks.singleFork` (every test file runs sequentially
    // in one worker — same single-process heap profile).
    pool: 'forks',
    fileParallelism: false,
    coverage: {
      provider: 'istanbul',
      // `include` is deliberately left unset: vitest 4 would instrument every
      // matching file outside the module graph (the old `all: true` behavior), and
      // measurement (issue 1510) showed `include: ['src/**']` drops the merged
      // package total to ~68.8% — below the 75% floor merge-coverage.mjs enforces —
      // because the whole untested-but-shipped surface (pages, providers, one-off
      // components) lands in the denominator at 0%. We do NOT lower the floor to
      // accommodate that. The new-untested-file hole it was meant to close — a
      // brand-new `src/**` file with no test never entering lcov.info, so
      // web:diff-coverage has nothing to measure and passes at 100% — is instead
      // closed by scripts/check-added-files-covered.mjs, wired into web:coverage
      // (whose node image can run it; web:diff-coverage's python image cannot):
      // it fails the gate if any file added in the MR is absent from the merged
      // coverage map. That targets exactly the dodge (a *new* untested file) without
      // dragging the historical untested surface into the floor. `exclude` below
      // still filters the loaded set (generated code, the test double).
      // 'text' prints to stdout for the package-total CI gate; 'lcov' writes
      // coverage/lcov.info which `diff-cover` consumes for the diff-coverage
      // gate (see Makefile coverage-diff-web). 'json' writes coverage-final.json,
      // the istanbul data file that scripts/merge-coverage.mjs stitches across the
      // web:test shards in CI — a map-level merge in the cached node image, far
      // cheaper than the GNU lcov install (perl + binutils, ~5 min) it replaced.
      reporter: ['text', 'lcov', 'json'],
      reportsDirectory: './coverage',
      // Merge with the vitest defaults so node_modules, dist, etc. stay excluded.
      // A custom exclude list replaces (not extends) the defaults, so we must
      // spread coverageConfigDefaults.exclude explicitly.
      exclude: [
        ...coverageConfigDefaults.exclude,
        'src/test/**',
        'src/api/types.ts', // openapi-typescript generated — not hand-authored code
        // GanttEngineStub is a hand-written test double, not production code — it
        // stands in for the canvas-bound engine in component tests, so measuring its
        // own coverage is meaningless. The formerly-excluded engine/renderer files
        // (GanttEngineImpl.ts, GanttRenderer.ts, ScheduleAriaOverlay.tsx,
        // useGanttEngine.ts) are now instrumented: real unit tests exist for them
        // (GanttEngineImpl.test.ts, GanttRenderer.test.ts, ScheduleAriaOverlay.*.test.ts),
        // so the "not unit-testable in jsdom" rationale was stale — coverage was
        // measured and then discarded (issue 1510). The stale CanvasGanttTimeline.tsx
        // entry was dropped: that file no longer exists.
        'src/features/schedule/engine/GanttEngineStub.ts', // test double — not production code
        // Pure re-export barrel (web-rule 217 dialog primitives): it has no
        // executable statements, so v8 never records it in lcov even when
        // imported, and check-added-files-covered.mjs would flag it forever.
        // Its re-exports are validated by tsc; the underlying modules are tested.
        'src/components/dialog/index.ts',
        // Type-only module: exports a single `interface RouteHandle` and no
        // executable statements, so istanbul never records it in lcov even when
        // imported, and check-added-files-covered.mjs would flag it forever.
        // Its shape is validated by tsc; its consumer (RouteTitle) is tested.
        'src/router/routeHandle.ts',
      ],
      // No per-process thresholds: web:test is sharded (vitest --shard), so each
      // process only loads ~1/3 of the suite and would measure a partial coverage
      // total against the full denominator — tripping any threshold here. vitest
      // never sees the merged result (GNU lcov stitches the shards in web:coverage),
      // so the package-total line floor is enforced there instead, mirroring the
      // api:coverage --fail-under floor. The primary gate remains web:diff-coverage.
    },
  },
});
