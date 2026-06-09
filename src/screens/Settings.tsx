// Settings shell: a left sub-nav of pages + the active page's content. Each page
// lives in its own component (under ./settings, plus the shared SecuritySettings),
// so the settings surface is split into focused pages rather than one long scroll.
// Reached from the sidebar.

import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import { ArrowLeft, DownloadCloud, Gauge, Info, Palette, PanelLeft, Search, ShieldAlert, ShieldCheck, Users } from 'lucide-solid';
import AppearanceSettings from './settings/AppearanceSettings.tsx';
import ConnectionsSettings from './settings/ConnectionsSettings.tsx';
import UnlockSettings from './settings/UnlockSettings.tsx';
import AuditSettings from './settings/AuditSettings.tsx';
import UpdatesSettings from './settings/UpdatesSettings.tsx';
import SidebarSettings from './settings/SidebarSettings.tsx';
import SecuritySettings from '../components/SecuritySettings.tsx';
import './Settings.css';

type Page = 'connections' | 'unlock' | 'security' | 'audits' | 'appearance' | 'sidebar' | 'updates';

// `keywords` lets the nav filter match concepts that aren't in the visible label
// (e.g. "clipboard" / "timeout" → Security, "theme" → Appearance).
const PAGES: { id: Page; label: string; icon: typeof Info; keywords: string }[] = [
  { id: 'connections', label: 'Connections', icon: Users, keywords: 'account email server login add remove' },
  { id: 'unlock', label: 'Unlock', icon: ShieldCheck, keywords: 'password windows hello biometric pin device' },
  { id: 'security', label: 'Security', icon: ShieldAlert, keywords: 'clipboard auto-lock timeout breach dark web exposed monitor' },
  { id: 'audits', label: 'Audits', icon: Gauge, keywords: 'health score weak reused old totp threshold' },
  { id: 'appearance', label: 'Appearance', icon: Palette, keywords: 'theme dark light density rows color' },
  { id: 'sidebar', label: 'Sidebar', icon: PanelLeft, keywords: 'rail entries order saved queries' },
  { id: 'updates', label: 'Updates', icon: DownloadCloud, keywords: 'version auto update install release about license credits' },
];

export default function Settings(props: { onBack: () => void }) {
  const [page, setPage] = createSignal<Page>('connections');
  const [filter, setFilter] = createSignal('');

  // Pages whose label or keywords match the filter. Empty filter → all pages.
  const shownPages = createMemo(() => {
    const q = filter().trim().toLowerCase();
    if (!q) return PAGES;
    return PAGES.filter((p) => p.label.toLowerCase().includes(q) || p.keywords.includes(q));
  });

  return (
    <div class="settings">
      <header class="settings-header">
        <button class="ghost icon-btn" title="Back" onClick={() => props.onBack()}>
          <ArrowLeft size={16} strokeWidth={1.75} />
        </button>
        <h2>Settings</h2>
      </header>

      <div class="settings-layout">
        <nav class="settings-nav">
          <div class="settings-nav-search">
            <Search size={14} strokeWidth={1.75} />
            <input
              type="text"
              placeholder="Search settings"
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value)}
            />
          </div>
          <For each={shownPages()}>
            {(p) => {
              const Icon = p.icon;
              return (
                <button
                  class="settings-nav-item"
                  classList={{ active: page() === p.id }}
                  title={p.label}
                  onClick={() => setPage(p.id)}
                >
                  <Icon size={15} strokeWidth={1.6} />
                  <span>{p.label}</span>
                </button>
              );
            }}
          </For>
          <Show when={shownPages().length === 0}>
            <p class="settings-nav-empty muted">No settings match.</p>
          </Show>
        </nav>

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
              </div>
            </Match>
            <Match when={page() === 'audits'}>
              <AuditSettings />
            </Match>
            <Match when={page() === 'appearance'}>
              <AppearanceSettings />
            </Match>
            <Match when={page() === 'sidebar'}>
              <SidebarSettings />
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
