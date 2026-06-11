// Lightweight, dependency-free i18n, structured like themia-app's: one nested
// message file per language under `src/locales`, flattened to dotted keys at load.
// `t(key)` reads the reactive `locale` signal, so any component using it re-renders
// when the language flips. `en` is the source of truth; other locales are
// PartialMessages and fall back to English per missing key. The locale persists in
// localStorage (a non-secret UI pref), validated at the storage boundary; the first
// run detects the OS language (maybeInitLanguageFromSystem).

import { createMemo, createSignal } from 'solid-js';
import { ipc } from './ipc.ts';
import { interpolate } from './i18nFormat.ts';
import { en } from '../locales/en.ts';
import { de } from '../locales/de.ts';
import { es } from '../locales/es.ts';

export type Locale = 'en' | 'de' | 'es';

export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'de', label: 'Deutsch' },
  { id: 'es', label: 'Español' },
];

const dictionaries: Record<Locale, Record<string, string>> = {
  en: flatten(en),
  de: flatten(de),
  es: flatten(es),
};

/** Flatten a nested message dict into a "a.b.c" → value map. */
function flatten(
  obj: Record<string, unknown>,
  prefix = '',
  out: Record<string, string> = {},
): Record<string, string> {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v as Record<string, unknown>, path, out);
    else out[path] = String(v);
  }
  return out;
}

const STORAGE_KEY = 'agate.locale';

function isLocale(v: unknown): v is Locale {
  return v === 'en' || v === 'de' || v === 'es';
}

function read(): Locale {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isLocale(v) ? v : 'en';
  } catch {
    // ignore: storage unavailable → default English
    return 'en';
  }
}

const [locale, setLocaleSignal] = createSignal<Locale>(read());
export { locale };

export function setLocale(l: Locale): void {
  setLocaleSignal(l);
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}

const missingLogged = new Set<string>();

/** Translate a key for the current locale, falling back to English. Reactive:
 *  reads the `locale` signal, so JSX consumers re-render on a language change.
 *  Interpolates `{name}` placeholders from `params`. Unknown keys are logged once
 *  and returned verbatim so a missing translation is visible, never a silent gap. */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = dictionaries[locale()] ?? dictionaries.en;
  const s = dict[key] ?? dictionaries.en[key];
  if (s === undefined) {
    if (!missingLogged.has(key)) {
      missingLogged.add(key);
      console.warn(`[i18n] missing key: ${key}`);
    }
    return key;
  }
  return interpolate(s, params);
}

/** Memo wrapper for a single reactive translation cell in JSX:
 *    <span>{tm('settings.title')()}</span>  */
export function tm(key: string, params?: Record<string, string | number>) {
  return createMemo(() => t(key, params));
}

/** First-run OS-locale detection. Best-effort and async — render immediately; if
 *  a language flip happens after detection, all consumers re-render reactively
 *  because t()/tm() read the `locale` signal. Only applies when the user has not
 *  already chosen a language (no persisted value). Called from main.tsx. */
export async function maybeInitLanguageFromSystem(): Promise<void> {
  try {
    if (localStorage.getItem(STORAGE_KEY)) return;
    const sys = (await ipc.getSystemLocale()) ?? '';
    const next: Locale = /^de/i.test(sys) ? 'de' : /^es/i.test(sys) ? 'es' : 'en';
    if (next !== locale()) setLocale(next);
  } catch {
    // ignore: detection is best-effort; default English stands
  }
}
