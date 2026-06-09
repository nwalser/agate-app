// Settings › Appearance — theme picker, language picker, and the Startup section.

import { For } from 'solid-js';
import { Monitor, Moon, Sun } from 'lucide-solid';
import { setTheme, theme, type ThemePref } from '../../state/theme.ts';
import { LOCALES, locale, setLocale, t, type Key } from '../../lib/i18n.ts';
import StartupSettings from './StartupSettings.tsx';

const THEME_OPTIONS: { value: ThemePref; labelKey: Key; icon: typeof Sun }[] = [
  { value: 'system', labelKey: 'theme.system', icon: Monitor },
  { value: 'light', labelKey: 'theme.light', icon: Sun },
  { value: 'dark', labelKey: 'theme.dark', icon: Moon },
];

export default function AppearanceSettings() {
  return (
    <div class="settings-page">
      <section class="settings-section">
        <h3>{t('appearance.title')}</h3>
        <p class="muted settings-help">{t('appearance.help')}</p>
        <div class="theme-options">
          <For each={THEME_OPTIONS}>
            {(opt) => {
              const Icon = opt.icon;
              return (
                <button
                  class="theme-option"
                  classList={{ active: theme() === opt.value }}
                  onClick={() => setTheme(opt.value)}
                >
                  <Icon size={16} strokeWidth={1.6} />
                  <span>{t(opt.labelKey)}</span>
                </button>
              );
            }}
          </For>
        </div>

        <h3 class="sec-subhead">{t('appearance.language')}</h3>
        <p class="muted settings-help">{t('appearance.languageHelp')}</p>
        <div class="theme-options">
          <For each={LOCALES}>
            {(l) => (
              <button
                class="theme-option"
                classList={{ active: locale() === l.id }}
                onClick={() => setLocale(l.id)}
              >
                <span>{l.label}</span>
              </button>
            )}
          </For>
        </div>
      </section>
      <StartupSettings />
    </div>
  );
}
