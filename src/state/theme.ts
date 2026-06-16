// UI theme preference. Not a secret — persisted in localStorage (not the
// keychain) through the shared createPersistedStore trust boundary. The resolved
// theme is applied as `data-theme` on <html>, which the design tokens in
// styles.css key off. `system` follows the OS color scheme.

import { createSignal } from 'solid-js';

import { createPersistedStore, parseOneOf } from './persisted.ts';

export type ThemePref = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

// The persisted pref goes through the shared store (validate-on-read, best-effort
// write); anything that isn't one of the three known values falls back to
// `system`. Stored raw ("light"/"dark"/"system"), back-compatible with the
// hand-rolled key this replaces.
const prefStore = createPersistedStore<ThemePref>({
  key: 'agate.theme',
  raw: true,
  parse: parseOneOf(['system', 'light', 'dark'] as const),
  fallback: () => 'system',
});

const media =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null;

function systemTheme(): ResolvedTheme {
  return media?.matches ? 'light' : 'dark';
}

const theme = prefStore.value;
const [resolvedTheme, setResolved] = createSignal<ResolvedTheme>('dark');

function apply() {
  const pref = theme();
  const r: ResolvedTheme = pref === 'system' ? systemTheme() : pref;
  setResolved(r);
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = r;
  }
}

export function setTheme(pref: ThemePref) {
  prefStore.set(pref);
  apply();
}

// Re-read the persisted pref and repaint. The tray popup runs in its own
// webview, so a theme change made in the main window only reaches it through
// localStorage — the popup calls this every time it gains focus.
export function syncThemeFromStorage() {
  prefStore.refresh();
  apply();
}

// Call once at startup: paint the stored theme and track OS changes while on
// `system`.
export function initTheme() {
  apply();
  media?.addEventListener('change', () => {
    if (theme() === 'system') apply();
  });
}

export { theme, resolvedTheme };
