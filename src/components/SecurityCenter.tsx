// Security center: the tabbed shell that routes between the four security views.
// Each tab is its own module under ./security/; this file owns only the header,
// the tab strip, and the active-tab routing. The .sec-* CSS shared by all the
// subviews is imported here. Keeps its default export + props identical so its
// caller doesn't change.

import { createSignal, For, Show } from 'solid-js';
import { ShieldCheck } from 'lucide-solid';
import BreachDirectory from './security/BreachDirectory.tsx';
import DarkWebBreachView from './security/DarkWebBreachView.tsx';
import ExposedPasswordsView from './security/ExposedPasswordsView.tsx';
import VaultHealth from './security/VaultHealth.tsx';
import './SecurityCenter.css';

type Tab = 'overview' | 'exposed' | 'darkweb' | 'breaches';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'exposed', label: 'Exposed passwords' },
  { id: 'darkweb', label: 'Dark web monitor' },
  { id: 'breaches', label: 'Breaches' },
];

export default function SecurityCenter(props: { onOpenItem: (id: string) => void }) {
  const [tab, setTab] = createSignal<Tab>('overview');

  return (
    <div class="sec">
      <header class="sec-header">
        <ShieldCheck size={16} strokeWidth={1.75} />
        <h2>Vault security</h2>
      </header>

      <nav class="sec-tabs">
        <For each={TABS}>
          {(t) => (
            <button class="sec-tab" classList={{ active: tab() === t.id }} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          )}
        </For>
      </nav>

      <div class="sec-body">
        <Show when={tab() === 'overview'}>
          <VaultHealth onOpenItem={props.onOpenItem} />
        </Show>
        <Show when={tab() === 'exposed'}>
          <ExposedPasswordsView onOpenItem={props.onOpenItem} />
        </Show>
        <Show when={tab() === 'darkweb'}>
          <DarkWebBreachView />
        </Show>
        <Show when={tab() === 'breaches'}>
          <BreachDirectory />
        </Show>
      </div>
    </div>
  );
}
