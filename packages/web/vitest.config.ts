/// <reference types="vitest" />
import { defineConfig, coverageConfigDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    globals: true,
    // Run all tests in a single forked process — avoids spawning multiple workers
    // that each inflate their own jsdom + RTL heap, which caused OOM on the default
    // multi-fork pool when the suite grew past ~20 test files.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: 'istanbul',
      // Only report coverage for files actually loaded during the test run.
      // all:true (the default) would instrument every file in src/ outside the
      // module graph and inflate the coverage denominator with uncollected files.
      all: false,
      reporter: ['text'],
      include: ['src/**/*.{ts,tsx}'],
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
        'src/features/gantt/engine/GanttEngineImpl.ts',
        'src/features/gantt/engine/GanttRenderer.ts',
        'src/features/gantt/engine/GanttEngineStub.ts', // test double — not production code
        'src/features/gantt/CanvasGanttTimeline.tsx',
        'src/features/gantt/GanttAriaOverlay.tsx',
        'src/hooks/useGanttEngine.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
