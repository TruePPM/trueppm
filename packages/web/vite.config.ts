import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

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
