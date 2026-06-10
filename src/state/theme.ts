// UI theme preference. Not a secret — persisted in localStorage (not the
// keychain). The resolved theme is applied as `data-theme` on <html>, which the
// design tokens in styles.css key off. `system` follows the OS color scheme.

import { createSignal } from 'solid-js';

export type ThemePref = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'agate.theme';

// Validate at the storage trust boundary: anything that isn't one of the three
// known prefs (absent key, or a corrupt/tampered value) falls back to `system`.
function readStored(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // ignore: localStorage may be unavailable (private mode); use the default
  }
  return 'system';
}

const media =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null;

function systemTheme(): ResolvedTheme {
  return media?.matches ? 'light' : 'dark';
}

const [theme, setThemeSignal] = createSignal<ThemePref>(readStored());
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
  setThemeSignal(pref);
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
  apply();
}

// Re-read the persisted pref and repaint. The tray popup runs in its own
// webview, so a theme change made in the main window only reaches it through
// localStorage — the popup calls this every time it gains focus.
export function syncThemeFromStorage() {
  setThemeSignal(readStored());
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
