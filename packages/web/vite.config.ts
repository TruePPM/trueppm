import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
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
      provider: 'v8',
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
