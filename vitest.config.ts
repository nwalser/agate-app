import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  // Mirror vite.config's build-time gate so modules that reference it
  // (lib/ipc.ts, state/session.ts) load under vitest instead of throwing
  // `__AGATE_TEST_HOOKS__ is not defined`. The `navigator.webdriver` runtime
  // check is still false under jsdom, so no test hook is actually installed.
  define: {
    __AGATE_TEST_HOOKS__: JSON.stringify(true),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
  resolve: {
    conditions: ['development', 'browser'],
  },
});
