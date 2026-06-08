/// <reference types="vite/client" />

// Build-time constant injected by vite's `define` (see vite.config.ts). Gates the
// test-only IPC seam; `true` for dev + Tauri debug builds, `false` (and so
// dead-code-eliminated) in a real release build.
declare const __AGATE_TEST_HOOKS__: boolean;
