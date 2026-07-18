import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { defineConfig } from 'vite';
import type { PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import istanbul from 'vite-plugin-istanbul';
import { resolve } from 'path';

const buildSha = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'dev';
  }
})();

const appVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
})();

// API_URL (no VITE_ prefix) is the server-side proxy target used only by
// the Vite dev server — it is never exposed to the browser bundle.
// Set to http://api:8000 in Docker Compose so the proxy reaches the api
// container by name.  Unset on the host falls back to http://localhost:8000.
// API_URL (no VITE_ prefix) is server-side only — used by the Vite dev proxy,
// never exposed to the browser bundle.  Set to http://api:8000 in Docker Compose
// so the proxy reaches the api container by name; unset on the host falls back
// to http://localhost:8000.
const apiUrl = process.env['API_URL'] ?? 'http://localhost:8000';
const wsUrl = apiUrl.replace(/^http/, 'ws');

// E2E coverage build (issue #2117). Gated on VITE_COVERAGE so the production
// build is never instrumented. The instrumented modules populate
// `window.__coverage__`; the Playwright coverage fixture (e2e/fixtures/coverage.ts)
// reads it per test and the merge script emits an LCOV that SonarCloud imports
// alongside the vitest report — so UI files exercised only by E2E stop reading as
// 0% covered. Instrument the same product surface vitest measures (exclude tests,
// generated types, test doubles) so the two reports union cleanly rather than
// double-counting or measuring throwaway files.
const coverage = process.env['VITE_COVERAGE'] === 'true';
const coveragePlugins: PluginOption[] = coverage
  ? [
      istanbul({
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        exclude: [
          'node_modules',
          'src/test/**',
          'src/**/*.test.ts',
          'src/**/*.test.tsx',
          'src/**/*.d.ts',
          'src/api/types.ts', // openapi-typescript generated — not hand-authored
          'src/features/schedule/engine/GanttEngineStub.ts', // test double
        ],
        extension: ['.ts', '.tsx'],
        requireEnv: false,
        forceBuildInstrument: true, // instrument during `vite build`, not just dev
      }),
    ]
  : [];

export default defineConfig({
  plugins: [react(), ...coveragePlugins],
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: apiUrl,
        changeOrigin: true,
      },
      // Narrow to /ws/v1/ so only API WebSocket paths are forwarded.
      // Other /ws/* connections (browser extensions, HMR noise) are not proxied.
      '/ws/v1': {
        target: wsUrl,
        ws: true,
      },
    },
  },
});
