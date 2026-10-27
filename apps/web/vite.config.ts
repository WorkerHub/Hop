import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
// ONE-579: vitest/config re-exports Vite's defineConfig plus the `test` field, so
// the DOM regression suite reuses the same aliases and React plugin as the app.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // ONE-579: browser-level regression tests (jsdom + React 19). `node --test`
    // covers pure modules only, which is why the 2FA landing bug shipped.
    environment: 'jsdom',
    include: ['src/**/*.dom.test.{ts,tsx}'],
  },
  server: {
    proxy: {
      '/api': {
        // CI-C9: the worker origin is configurable so local setups that run the
        // worker on a different host/port don't have to edit this file.
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
