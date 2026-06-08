import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

// Tauri expects a fixed dev port and leaves the screen clear for its own logs.
// `target/` (Rust build output, tens of thousands of files) is excluded from the
// file watcher so the dev server doesn't spend ~40s registering OS watch handles
// on startup.
export default defineConfig(({ command }) => ({
  // Build-time gate for the test-only IPC seam (src/lib/ipc.ts, src/state/session.ts).
  // True for `vite serve` (dev + the e2e harness) and for Tauri debug builds —
  // `tauri dev` and the e2e `tauri build --debug` both export TAURI_ENV_DEBUG=true.
  // A real release (`tauri build`, TAURI_ENV_DEBUG unset) makes it `false`, so the
  // seam is dead-code-eliminated and never ships in a release binary.
  define: {
    __AGATE_TEST_HOOKS__: JSON.stringify(
      command === 'serve' || process.env.TAURI_ENV_DEBUG === 'true',
    ),
  },
  plugins: [solid()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**', '**/target/**', '**/dist/**', '**/node_modules/**'],
    },
  },
  build: {
    // Tauri targets modern WebView2/WebKit — no legacy transpilation needed.
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
}));
