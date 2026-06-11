// Settings › Appearance — theme picker, language picker, the item-list layout
// preferences (layout / density / favicons — these used to live in the list's gear
// menu, which is gone), and the Startup section.

import { Image } from 'lucide-solid';
import { setTheme, theme, type ThemePref } from '../../state/theme.ts';
import { LOCALES, locale, setLocale, t } from '../../lib/i18n.ts';
import { columns, setDisplayMode, setFavicons, type DisplayMode } from '../../state/columns.ts';
import { rowDensity, setRowDensity, type RowDensity } from '../../state/ui.ts';
import { Select, ToggleRow } from '../../components/settings/SettingsControls.tsx';
import StartupSettings from './StartupSettings.tsx';

const THEME_OPTIONS: { value: ThemePref; labelKey: string }[] = [
  { value: 'system', labelKey: 'theme.system' },
  { value: 'light', labelKey: 'theme.light' },
  { value: 'dark', labelKey: 'theme.dark' },
];

const LAYOUT_OPTIONS: { value: DisplayMode; labelKey: string }[] = [
  { value: 'table', labelKey: 'appearance.layoutTable' },
  { value: 'list', labelKey: 'appearance.layoutList' },
];

const DENSITY_OPTIONS: { value: RowDensity; labelKey: string }[] = [
  { value: 'compact', labelKey: 'appearance.densityCompact' },
  { value: 'default', labelKey: 'appearance.densityDefault' },
  { value: 'comfortable', labelKey: 'appearance.densityComfortable' },
];

export default function AppearanceSettings() {
  return (
    <div class="settings-page">
      <section class="settings-section">
        <h3>{t('appearance.title')}</h3>
        <p class="muted settings-help">{t('appearance.help')}</p>
        <Select
          ariaLabel={t('appearance.title')}
          value={theme()}
          options={THEME_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
          onChange={(v) => setTheme(v)}
        />

        <h3 class="sec-subhead">{t('appearance.language')}</h3>
        <p class="muted settings-help">{t('appearance.languageHelp')}</p>
        <Select
          ariaLabel={t('appearance.language')}
          value={locale()}
          options={LOCALES.map((l) => ({ value: l.id, label: l.label }))}
          onChange={(v) => setLocale(v)}
        />
      </section>

      <section class="settings-section">
        <h3>{t('appearance.itemList')}</h3>
        <p class="muted settings-help">{t('appearance.itemListHelp')}</p>
        <Select
          ariaLabel={t('appearance.layout')}
          value={columns().displayMode}
          options={LAYOUT_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
          onChange={(v) => setDisplayMode(v)}
        />
        <h3 class="sec-subhead">{t('appearance.density')}</h3>
        <Select
          ariaLabel={t('appearance.density')}
          value={rowDensity()}
          options={DENSITY_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
          onChange={(v) => setRowDensity(v)}
        />
        <h3 class="sec-subhead">{t('appearance.columns')}</h3>
        <ToggleRow
          icon={Image}
          label={t('appearance.favicons')}
          desc={t('appearance.faviconsDesc')}
          checked={columns().favicons}
          onChange={(v) => setFavicons(v)}
        />
      </section>

      <StartupSettings />
    </div>
  );
}
