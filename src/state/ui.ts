// Non-secret UI preferences, persisted in localStorage (not the keychain):
//   * sidebar collapse state
//   * which vault (connection) the list is scoped to — null = all connections
//     merged (the unified view), or a connection email for a single vault.
// Validated at the storage boundary; corrupt/unavailable storage falls back to
// safe defaults.

import { createSignal } from 'solid-js';

const COLLAPSE_KEY = 'agate.sidebarCollapsed';
const WIDTH_KEY = 'agate.sidebarWidth';
const PREVIEW_KEY = 'agate.previewCollapsed';
const DENSITY_KEY = 'agate.rowDensity';
const ACTIVE_VAULT_KEY = 'agate.activeVault';

function readBool(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    // ignore: storage unavailable → default collapsed=false
    return false;
  }
}

// ---- sidebar collapse ----

const [sidebarCollapsed, setCollapsedSignal] = createSignal(readBool(COLLAPSE_KEY));
export { sidebarCollapsed };

export function toggleSidebar() {
  const next = !sidebarCollapsed();
  setCollapsedSignal(next);
  try {
    localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}

// ---- sidebar width (drag-to-resize) ----
// The shared width of every left sidebar (the vault rail + the Settings sub-nav),
// driven onto the `--sidebar-width` CSS variable in App.tsx. Persisted like the
// collapse flag; clamped to a sane range so a dragged or tampered value can never
// hide the sidebar or eat the whole window.

export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 216;

function clampWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(px)));
}

function readWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (raw === null) return SIDEBAR_DEFAULT_WIDTH;
    const n = Number.parseInt(raw, 10);
    return Number.isNaN(n) ? SIDEBAR_DEFAULT_WIDTH : clampWidth(n);
  } catch {
    // ignore: storage unavailable → default width
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

const [sidebarWidth, setWidthSignal] = createSignal(readWidth());
export { sidebarWidth };

/** Set the shared sidebar width in px (drag-resize). Clamped + persisted. */
export function setSidebarWidth(px: number) {
  const next = clampWidth(px);
  setWidthSignal(next);
  try {
    localStorage.setItem(WIDTH_KEY, String(next));
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}

/** Restore the default sidebar width (double-click the resize handle). */
export function resetSidebarWidth() {
  setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
}

// ---- detail (preview) pane collapse ----
// Hides the right-hand detail pane so the item list spans the full width (and can
// show more columns). Persisted like the sidebar; opening the inline editor forces
// the pane back so the form is always visible (handled in Vault.tsx).

const [previewCollapsed, setPreviewSignal] = createSignal(readBool(PREVIEW_KEY));
export { previewCollapsed };

function persistPreview(next: boolean) {
  setPreviewSignal(next);
  try {
    localStorage.setItem(PREVIEW_KEY, next ? '1' : '0');
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}

export function togglePreview() {
  persistPreview(!previewCollapsed());
}

// ---- list row density ----
// A global viewing preference (not per-list): how tall the vault rows are. Drives
// a `data-density` attribute on the list; the CSS adjusts row padding.

/** Closed set of row densities — never a bare string at the trust boundary. */
export type RowDensity = 'compact' | 'default' | 'comfortable';

function readDensity(): RowDensity {
  try {
    const v = localStorage.getItem(DENSITY_KEY);
    return v === 'compact' || v === 'comfortable' ? v : 'default';
  } catch {
    // ignore: storage unavailable → default density
    return 'default';
  }
}

const [rowDensity, setDensitySignal] = createSignal<RowDensity>(readDensity());
export { rowDensity };

export function setRowDensity(d: RowDensity) {
  setDensitySignal(d);
  try {
    localStorage.setItem(DENSITY_KEY, d);
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}

// ---- active vault (connection scope) ----

function readActiveVault(): string | null {
  try {
    const v = localStorage.getItem(ACTIVE_VAULT_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    // ignore: storage unavailable → default to the unified "all vaults" view
    return null;
  }
}

const [activeVault, setActiveVaultSignal] = createSignal<string | null>(readActiveVault());
export { activeVault };

/** Scope the list to a single connection email, or null for all vaults merged. */
export function setActiveVault(email: string | null) {
  setActiveVaultSignal(email);
  try {
    if (email) localStorage.setItem(ACTIVE_VAULT_KEY, email);
    else localStorage.removeItem(ACTIVE_VAULT_KEY);
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}
