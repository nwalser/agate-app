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
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      // Exclude non-product code: tests + factories, generated IPC types, the
      // type-only env shim, and the entry point (mostly wiring, not unit-tested).
      exclude: [
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/testing/**',
        'src/lib/generated/**',
        'src/vite-env.d.ts',
        'src/main.tsx',
      ],
      // Seeded a few points below the current baseline (86% lines / 88% branches
      // / 75% functions) so a real coverage regression fails CI without flaking on
      // ordinary churn. Ratchet upward over time.
      thresholds: {
        lines: 80,
        statements: 80,
        branches: 80,
        functions: 70,
      },
    },
  },
  resolve: {
    conditions: ['development', 'browser'],
  },
});
