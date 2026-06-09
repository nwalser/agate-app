// Settings › Appearance — theme picker, language picker, the item-list layout
// preferences (layout / density / favicons — these used to live in the list's gear
// menu, which is gone), and the Startup section.

import { Image, List, Monitor, Moon, Sun, Table } from 'lucide-solid';
import { setTheme, theme, type ThemePref } from '../../state/theme.ts';
import { LOCALES, locale, setLocale, t, type Key } from '../../lib/i18n.ts';
import { columns, setDisplayMode, setFavicons, type DisplayMode } from '../../state/columns.ts';
import { rowDensity, setRowDensity, type RowDensity } from '../../state/ui.ts';
import { Segmented, ToggleRow } from '../../components/settings/SettingsControls.tsx';
import StartupSettings from './StartupSettings.tsx';

const THEME_OPTIONS: { value: ThemePref; labelKey: Key; icon: typeof Sun }[] = [
  { value: 'system', labelKey: 'theme.system', icon: Monitor },
  { value: 'light', labelKey: 'theme.light', icon: Sun },
  { value: 'dark', labelKey: 'theme.dark', icon: Moon },
];

const LAYOUT_OPTIONS: { value: DisplayMode; label: string; icon: typeof Table }[] = [
  { value: 'table', label: 'Table', icon: Table },
  { value: 'list', label: 'List', icon: List },
];

const DENSITY_OPTIONS: { value: RowDensity; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'default', label: 'Default' },
  { value: 'comfortable', label: 'Comfortable' },
];

export default function AppearanceSettings() {
  return (
    <div class="settings-page">
      <section class="settings-section">
        <h3>{t('appearance.title')}</h3>
        <p class="muted settings-help">{t('appearance.help')}</p>
        <Segmented
          ariaLabel={t('appearance.title')}
          value={theme()}
          options={THEME_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey), icon: o.icon }))}
          onChange={(v) => setTheme(v)}
        />

        <h3 class="sec-subhead">{t('appearance.language')}</h3>
        <p class="muted settings-help">{t('appearance.languageHelp')}</p>
        <Segmented
          ariaLabel={t('appearance.language')}
          value={locale()}
          options={LOCALES.map((l) => ({ value: l.id, label: l.label }))}
          onChange={(v) => setLocale(v)}
        />
      </section>

      <section class="settings-section">
        <h3>Item list</h3>
        <p class="muted settings-help">
          How the vault list looks. Show, hide, reorder, sort, and filter individual columns
          right from their header — click a header to sort, or right-click it for the full menu.
        </p>
        <Segmented
          ariaLabel="List layout"
          value={columns().displayMode}
          options={LAYOUT_OPTIONS}
          onChange={(v) => setDisplayMode(v)}
        />
        <h3 class="sec-subhead">Row density</h3>
        <Segmented
          ariaLabel="Row density"
          value={rowDensity()}
          options={DENSITY_OPTIONS}
          onChange={(v) => setRowDensity(v)}
        />
        <h3 class="sec-subhead">Columns</h3>
        <ToggleRow
          icon={Image}
          label="Website favicons"
          desc="Show each login's site icon in the Name column."
          checked={columns().favicons}
          onChange={(v) => setFavicons(v)}
        />
      </section>

      <StartupSettings />
    </div>
  );
}
