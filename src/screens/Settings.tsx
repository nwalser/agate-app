// Settings shell: a left sub-nav of pages + the active page's content. Each page
// lives in its own component (under ./settings, plus the shared SecuritySettings),
// so the settings surface is split into focused pages rather than one long scroll.
// Reached from the sidebar.

import { createSignal, For, Match, Switch } from 'solid-js';
import { ArrowLeft, DownloadCloud, Gauge, Info, Palette, ShieldAlert, ShieldCheck, Users } from 'lucide-solid';
import AppearanceSettings from './settings/AppearanceSettings.tsx';
import ConnectionsSettings from './settings/ConnectionsSettings.tsx';
import UnlockSettings from './settings/UnlockSettings.tsx';
import AuditSettings from './settings/AuditSettings.tsx';
import UpdatesSettings from './settings/UpdatesSettings.tsx';
import AboutSettings from './settings/AboutSettings.tsx';
import SecuritySettings from '../components/SecuritySettings.tsx';
import './Settings.css';

type Page = 'connections' | 'unlock' | 'security' | 'audits' | 'appearance' | 'updates' | 'about';

const PAGES: { id: Page; label: string; icon: typeof Info }[] = [
  { id: 'connections', label: 'Connections', icon: Users },
  { id: 'unlock', label: 'Unlock', icon: ShieldCheck },
  { id: 'security', label: 'Security', icon: ShieldAlert },
  { id: 'audits', label: 'Audits', icon: Gauge },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'updates', label: 'Updates', icon: DownloadCloud },
  { id: 'about', label: 'About', icon: Info },
];

export default function Settings(props: { onBack: () => void }) {
  const [page, setPage] = createSignal<Page>('connections');

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
          <For each={PAGES}>
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
            <Match when={page() === 'updates'}>
              <UpdatesSettings />
            </Match>
            <Match when={page() === 'about'}>
              <AboutSettings />
            </Match>
          </Switch>
        </div>
      </div>
    </div>
  );
}
