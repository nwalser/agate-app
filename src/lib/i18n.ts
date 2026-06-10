// Lightweight, dependency-free i18n. `t(key)` reads the reactive `locale` signal,
// so any component using it re-renders when the language changes. `en` is the
// source of truth (its keys define the `Key` type); other locales may be partial
// and fall back to `en` for missing keys. Locale persists in localStorage (a
// non-secret UI pref), validated at the storage boundary.
//
// Coverage is incremental: surfaces are migrated to `t()` over time. Unmigrated
// strings simply stay in English until they're keyed.

import { createSignal } from 'solid-js';

export type Locale = 'en' | 'es';

export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Español' },
];

// English base — the full key set. Every other locale is a Partial of this.
const en = {
  'common.back': 'Back',
  'common.close': 'Close',
  'common.enable': 'Enable',
  'common.disable': 'Disable',
  'common.retry': 'Retry',

  'settings.title': 'Settings',
  'settings.search': 'Search settings',
  'settings.empty': 'No settings match.',
  'settings.group.vault': 'Vault',
  'settings.group.global': 'Global',

  'nav.connections': 'Connections',
  'nav.export': 'Export',
  'nav.unlock': 'Unlock',
  'nav.security': 'Security',
  'nav.appearance': 'Appearance',
  'nav.sidebar': 'Sidebar',
  'nav.templates': 'Templates',
  'nav.aiAccess': 'AI Access',
  'nav.updates': 'Updates',
  'nav.about': 'About',

  'appearance.title': 'Appearance',
  'appearance.help': 'Choose a light or dark theme, or follow your system setting.',
  'appearance.language': 'Language',
  'appearance.languageHelp': 'The language Agate is displayed in.',
  'theme.system': 'System',
  'theme.light': 'Light',
  'theme.dark': 'Dark',

  'startup.title': 'Startup',
  'startup.help': 'Open Agate automatically when you sign in to your computer. It still starts locked.',
  'startup.launch': 'Launch at login',
  'startup.closeToTray': 'Keep running in the tray when the window is closed',
  'startup.closeToTrayDesc': 'Closing the window hides Agate instead of quitting; use the tray icon to reopen or quit.',

  'offline.message': 'Offline — showing your last synced vault. Changes you make may not reach the server yet.',

  'shortcuts.title': 'Keyboard shortcuts',
  'shortcuts.navigation': 'Navigation',
  'shortcuts.search': 'Search',
  'shortcuts.general': 'General',
} as const;

export type Key = keyof typeof en;

// Spanish overrides. Missing keys fall back to English.
const es: Partial<Record<Key, string>> = {
  'common.back': 'Atrás',
  'common.close': 'Cerrar',
  'common.enable': 'Activar',
  'common.disable': 'Desactivar',
  'common.retry': 'Reintentar',

  'settings.title': 'Ajustes',
  'settings.search': 'Buscar ajustes',
  'settings.empty': 'No hay ajustes que coincidan.',
  'settings.group.vault': 'Bóveda',
  'settings.group.global': 'Global',

  'nav.connections': 'Conexiones',
  'nav.export': 'Exportar',
  'nav.unlock': 'Desbloqueo',
  'nav.security': 'Seguridad',
  'nav.appearance': 'Apariencia',
  'nav.sidebar': 'Barra lateral',
  'nav.templates': 'Plantillas',
  'nav.aiAccess': 'Acceso IA',
  'nav.updates': 'Actualizaciones',
  'nav.about': 'Acerca de',

  'appearance.title': 'Apariencia',
  'appearance.help': 'Elige un tema claro u oscuro, o sigue la configuración del sistema.',
  'appearance.language': 'Idioma',
  'appearance.languageHelp': 'El idioma en que se muestra Agate.',
  'theme.system': 'Sistema',
  'theme.light': 'Claro',
  'theme.dark': 'Oscuro',

  'startup.title': 'Inicio',
  'startup.help': 'Abre Agate automáticamente al iniciar sesión en tu equipo. Sigue arrancando bloqueado.',
  'startup.launch': 'Abrir al iniciar sesión',
  'startup.closeToTray': 'Seguir en la bandeja al cerrar la ventana',
  'startup.closeToTrayDesc': 'Cerrar la ventana oculta Agate en vez de salir; usa el icono de la bandeja para reabrir o salir.',

  'offline.message': 'Sin conexión — mostrando tu última bóveda sincronizada. Tus cambios podrían no llegar al servidor todavía.',

  'shortcuts.title': 'Atajos de teclado',
  'shortcuts.navigation': 'Navegación',
  'shortcuts.search': 'Búsqueda',
  'shortcuts.general': 'General',
};

const DICTS: Record<Locale, Partial<Record<Key, string>>> = { en, es };

const STORAGE_KEY = 'agate.locale';

function read(): Locale {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'es' ? 'es' : 'en';
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

/** Translate a key for the current locale, falling back to English. */
export function t(key: Key): string {
  return DICTS[locale()][key] ?? en[key];
}
