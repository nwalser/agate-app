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
    // NOT vite's default 5173: themia (and any other vite project) grabs that
    // one, and whichever app's shell loads first would render the WRONG app's
    // frontend (tauri devUrl is a fixed URL). 5273 is Agate's own port, off the
    // 5173/5174/… auto-increment chain; strictPort fails LOUD instead of
    // silently drifting away from devUrl.
    port: 5273,
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
