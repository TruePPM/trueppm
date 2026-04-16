import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// VITE_API_URL is set to http://api:8000 when running inside Docker Compose
// so the Vite dev proxy reaches the api container by name.  When running
// npm run dev directly on the host the variable is unset and the proxy falls
// back to http://localhost:8000.
const apiUrl = process.env.VITE_API_URL ?? 'http://localhost:8000';
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
      '/ws': {
        target: wsUrl,
        ws: true,
      },
    },
  },
});
