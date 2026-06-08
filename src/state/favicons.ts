// Website favicon helper. Privacy: Agate fetches each site's icon directly from
// the site itself (https://host/favicon.ico) inside the webview — never through
// a third-party icon aggregator. The per-host outcome is remembered in
// localStorage so we don't re-attempt a site that has no icon, and the webview
// caches the bytes. Not secret (domains only); validated at the storage edge.

import { createSignal } from 'solid-js';

/** Which URL worked for a host, or that none did. */
export type FaviconState = 'ico' | 'apple' | 'none';

const STORAGE_KEY = 'agate.favicons.v1';

function read(): Record<string, FaviconState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, FaviconState> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === 'ico' || v === 'apple' || v === 'none') out[k] = v;
    }
    return out;
  } catch {
    // ignore: corrupt/unavailable cache falls back to empty (re-probe lazily)
    return {};
  }
}

const [statuses, setStatuses] = createSignal<Record<string, FaviconState>>(read());

function save(next: Record<string, FaviconState>) {
  setStatuses(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore: persistence is best-effort
  }
}

export function faviconStatus(host: string): FaviconState | undefined {
  return statuses()[host];
}

export function setFaviconStatus(host: string, s: FaviconState) {
  if (statuses()[host] === s) return;
  save({ ...statuses(), [host]: s });
}

/** Derive a bare lowercase host from an arbitrary URI/string, or null. */
export function hostOf(uri: string | null | undefined): string | null {
  if (!uri) return null;
  let s = uri.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    const h = new URL(s).hostname.toLowerCase();
    return h && h.includes('.') ? h : null;
  } catch {
    return null;
  }
}

export function icoUrl(host: string): string {
  return `https://${host}/favicon.ico`;
}

export function appleUrl(host: string): string {
  return `https://${host}/apple-touch-icon.png`;
}
