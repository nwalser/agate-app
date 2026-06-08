import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

// Tauri expects a fixed dev port and leaves the screen clear for its own logs.
// `target/` (Rust build output, tens of thousands of files) is excluded from the
// file watcher so the dev server doesn't spend ~40s registering OS watch handles
// on startup.
export default defineConfig({
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
});
