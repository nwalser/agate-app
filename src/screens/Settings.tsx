// Settings shell: a left sub-nav of pages + the active page's content. Each page
// lives in its own component (under ./settings, plus the shared SecuritySettings),
// so the settings surface is split into focused pages rather than one long scroll.
// Reached from the sidebar.

import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import { ArrowLeft, Bot, DownloadCloud, Info, LayoutTemplate, Palette, PanelLeft, Search, ShieldAlert, ShieldCheck, Users } from 'lucide-solid';
import AppearanceSettings from './settings/AppearanceSettings.tsx';
import AiAccessSettings from './settings/AiAccessSettings.tsx';
import ConnectionsSettings from './settings/ConnectionsSettings.tsx';
import UnlockSettings from './settings/UnlockSettings.tsx';
import AuditSettings from './settings/AuditSettings.tsx';
import UpdatesSettings from './settings/UpdatesSettings.tsx';
import SidebarSettings from './settings/SidebarSettings.tsx';
import TemplatesSettings from './settings/TemplatesSettings.tsx';
import SecuritySettings from '../components/SecuritySettings.tsx';
import ExportSettings from '../components/ExportSettings.tsx';
import Resizer from '../components/Resizer.tsx';
import { resetSidebarWidth, setSidebarWidth } from '../state/ui.ts';
import { t, type Key } from '../lib/i18n.ts';
import './Settings.css';

type Page = 'connections' | 'unlock' | 'security' | 'appearance' | 'sidebar' | 'templates' | 'aiAccess' | 'updates';

// Settings split into two groups: `vault` = per-connection (account-scoped) pages,
// `global` = app-wide preferences that apply across every connection.
type SettingsGroup = 'vault' | 'global';

const GROUPS: { id: SettingsGroup; label: string }[] = [
  { id: 'vault', label: 'Vault' },
  { id: 'global', label: 'Global' },
];

// `keywords` lets the nav filter match concepts that aren't in the visible label
// (e.g. "clipboard" / "timeout" → Security, "theme" → Appearance). `labelKey`
// drives the localized display label.
const PAGES: { id: Page; group: SettingsGroup; labelKey: Key; icon: typeof Info; keywords: string }[] = [
  { id: 'connections', group: 'vault', labelKey: 'nav.connections', icon: Users, keywords: 'account email server login add remove' },
  { id: 'unlock', group: 'global', labelKey: 'nav.unlock', icon: ShieldCheck, keywords: 'password windows hello biometric pin device' },
  { id: 'security', group: 'global', labelKey: 'nav.security', icon: ShieldAlert, keywords: 'clipboard auto-lock timeout breach dark web exposed monitor audit health score weak reused old totp threshold export import' },
  { id: 'appearance', group: 'global', labelKey: 'nav.appearance', icon: Palette, keywords: 'theme dark light density rows color language' },
  { id: 'sidebar', group: 'global', labelKey: 'nav.sidebar', icon: PanelLeft, keywords: 'rail entries order saved queries' },
  { id: 'templates', group: 'global', labelKey: 'nav.templates', icon: LayoutTemplate, keywords: 'template custom field new item preset skeleton reusable' },
  { id: 'aiAccess', group: 'global', labelKey: 'nav.aiAccess', icon: Bot, keywords: 'ai mcp claude assistant model context protocol allowlist grant token server reveal password' },
  { id: 'updates', group: 'global', labelKey: 'nav.updates', icon: DownloadCloud, keywords: 'version auto update install release about license credits' },
];

export default function Settings(props: { onBack: () => void }) {
  const [page, setPage] = createSignal<Page>('connections');
  const [filter, setFilter] = createSignal('');

  // Pages whose label or keywords match the filter. Empty filter → all pages.
  const shownPages = createMemo(() => {
    const q = filter().trim().toLowerCase();
    if (!q) return PAGES;
    return PAGES.filter((p) => t(p.labelKey).toLowerCase().includes(q) || p.keywords.includes(q));
  });

  return (
    <div class="settings">
      <header class="settings-header">
        <button class="ghost icon-btn" title={t('common.back')} onClick={() => props.onBack()}>
          <ArrowLeft size={16} strokeWidth={1.75} />
        </button>
        <h2>{t('settings.title')}</h2>
      </header>

      <div class="settings-layout">
        <nav class="settings-nav">
          <div class="settings-nav-search">
            <Search size={14} strokeWidth={1.75} />
            <input
              type="text"
              placeholder={t('settings.search')}
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value)}
            />
          </div>
          <For each={GROUPS}>
            {(g) => {
              const pages = createMemo(() => shownPages().filter((p) => p.group === g.id));
              return (
                <Show when={pages().length > 0}>
                  <div class="settings-nav-group">{g.label}</div>
                  <For each={pages()}>
                    {(p) => {
                      const Icon = p.icon;
                      return (
                        <button
                          class="settings-nav-item"
                          classList={{ active: page() === p.id }}
                          title={t(p.labelKey)}
                          onClick={() => setPage(p.id)}
                        >
                          <Icon size={15} strokeWidth={1.6} />
                          <span>{t(p.labelKey)}</span>
                        </button>
                      );
                    }}
                  </For>
                </Show>
              );
            }}
          </For>
          <Show when={shownPages().length === 0}>
            <p class="settings-nav-empty muted">{t('settings.empty')}</p>
          </Show>
        </nav>

        {/* Drag handle at the sub-nav's right edge — shares the vault rail's width. */}
        <Resizer
          variant="sidebar-resizer"
          label="Resize sidebar"
          onResize={setSidebarWidth}
          onReset={resetSidebarWidth}
        />

        <div class="settings-content">
          <Switch>
            <Match when={page() === 'connections'}>
              <ConnectionsSettings />
            </Match>
            <Match when={page() === 'unlock'}>
              <UnlockSettings />
            </Match>
            <Match when={page() === 'security'}>
              <div class="settings-page">
                <SecuritySettings />
                <AuditSettings />
                <ExportSettings />
              </div>
            </Match>
            <Match when={page() === 'appearance'}>
              <AppearanceSettings />
            </Match>
            <Match when={page() === 'sidebar'}>
              <SidebarSettings />
            </Match>
            <Match when={page() === 'templates'}>
              <TemplatesSettings />
            </Match>
            <Match when={page() === 'aiAccess'}>
              <AiAccessSettings />
            </Match>
            <Match when={page() === 'updates'}>
              <UpdatesSettings />
            </Match>
          </Switch>
        </div>
      </div>
    </div>
  );
}
