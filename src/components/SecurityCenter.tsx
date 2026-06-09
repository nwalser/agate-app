// Security center: a single-page dashboard that stacks every security view —
// vault health, exposed passwords, the dark-web monitor, and the breaches your
// accounts appear in — so the whole picture is visible without tab-switching.
// The vault-health audit is fetched once here and shared with both the dashboard
// summary and the dedicated At-risk items view (reached from the summary). Each
// section is its own module under ./security/; this file owns the header, the
// stacked layout, and the dashboard ⇄ at-risk routing. The .sec-* CSS shared by
// all the subviews is imported here. Keeps its default export + props identical
// so its caller doesn't change.

import { createSignal, Match, onMount, Switch } from 'solid-js';
import { ShieldCheck } from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import type { VaultHealthReport } from '../lib/types.ts';
import { toastError } from '../state/toast.ts';
import AtRiskView from './security/AtRiskView.tsx';
import BreachDirectory from './security/BreachDirectory.tsx';
import DarkWebBreachView from './security/DarkWebBreachView.tsx';
import ExposedPasswordsView from './security/ExposedPasswordsView.tsx';
import VaultHealth from './security/VaultHealth.tsx';
import './SecurityCenter.css';

type Subview = 'dashboard' | 'atRisk';

export default function SecurityCenter(props: { onOpenItem: (id: string) => void }) {
  const [subview, setSubview] = createSignal<Subview>('dashboard');
  const [report, setReport] = createSignal<VaultHealthReport | null>(null);
  const [healthLoading, setHealthLoading] = createSignal(true);

  onMount(() => {
    void (async () => {
      try {
        setReport(await ipc.auditOffline());
      } catch (err) {
        toastError(err);
      } finally {
        setHealthLoading(false);
      }
    })();
  });

  return (
    <div class="sec">
      <Switch>
        <Match when={subview() === 'atRisk'}>
          <AtRiskView
            report={report()}
            loading={healthLoading()}
            onOpenItem={props.onOpenItem}
            onBack={() => setSubview('dashboard')}
          />
        </Match>
        <Match when={subview() === 'dashboard'}>
          <header class="sec-header">
            <ShieldCheck size={16} strokeWidth={1.75} />
            <h2>Vault security</h2>
          </header>

          <div class="sec-body">
            <VaultHealth
              report={report()}
              loading={healthLoading()}
              onViewAtRisk={() => setSubview('atRisk')}
            />
            <ExposedPasswordsView onOpenItem={props.onOpenItem} />
            <DarkWebBreachView />
            <BreachDirectory />
          </div>
        </Match>
      </Switch>
    </div>
  );
}
