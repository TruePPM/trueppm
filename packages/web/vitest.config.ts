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
    // Don't crash the vitest fork on unhandled promise rejections. Components
    // that mount API-backed hooks (TanStack Query, polling) occasionally leak
    // XHR rejections after the test has finished — orphan rejections that
    // would otherwise terminate the worker with ERR_IPC_CHANNEL_CLOSED even
    // though every assertion passes. Real assertion failures still report
    // normally; this only suppresses async noise from unmounted components.
    dangerouslyIgnoreUnhandledErrors: true,
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
      // Only report coverage for files actually loaded during the test run.
      // Vitest 4 removed the `all` option: setting `coverage.include` now opts
      // into instrumenting every matching file outside the module graph (the old
      // `all: true` behavior), which would inflate the coverage denominator with
      // uncollected files. Leaving `include` unset reproduces the old `all: false`
      // — only files imported during the run are reported — with `exclude` below
      // still filtering that loaded set.
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
        // Canvas 2D renderer files require HTMLCanvasElement.getContext('2d') which
        // jsdom does not implement. These files are integration-tested via the
        // GanttEngineStub test double and visual regression tests — not unit-testable
        // in the jsdom environment.
        'src/features/schedule/engine/GanttEngineImpl.ts',
        'src/features/schedule/engine/GanttRenderer.ts',
        'src/features/schedule/engine/GanttEngineStub.ts', // test double — not production code
        'src/features/schedule/CanvasGanttTimeline.tsx',
        'src/features/schedule/ScheduleAriaOverlay.tsx',
        'src/hooks/useGanttEngine.ts',
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
