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
    // Alias @svar-ui/react-gantt to jsdom-safe mocks (SVAR uses HTMLCanvasElement internally).
    // CSS alias must come before the component alias — alias matching is prefix-based.
    alias: [
      {
        find: '@svar-ui/react-gantt/style.css',
        replacement: resolve(__dirname, 'src/test/mocks/empty.css'),
      },
      {
        find: '@svar-ui/react-gantt',
        replacement: resolve(__dirname, 'src/test/mocks/svar-gantt.tsx'),
      },
    ],
    coverage: {
      provider: 'istanbul',
      // Only report coverage for files actually loaded during the test run.
      // all:true (the default) would instrument every file in src/ outside the
      // module graph, meaning GanttView/GanttTimeline get processed without the
      // @svar-ui mock alias active — istanbul then follows the real library import
      // and hangs trying to instrument the entire commercial bundle.
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
