// Settings › Appearance — theme picker.

import { For } from 'solid-js';
import { Monitor, Moon, Sun } from 'lucide-solid';
import { setTheme, theme, type ThemePref } from '../../state/theme.ts';

const THEME_OPTIONS: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

export default function AppearanceSettings() {
  return (
    <div class="settings-page">
      <section class="settings-section">
        <h3>Appearance</h3>
        <p class="muted settings-help">Choose a light or dark theme, or follow your system setting.</p>
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
                  <span>{opt.label}</span>
                </button>
              );
            }}
          </For>
        </div>
      </section>
    </div>
  );
}
