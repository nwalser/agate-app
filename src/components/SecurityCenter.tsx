// Security center: a single-page dashboard that stacks every security view —
// vault health, exposed passwords, the dark-web monitor, and the breaches your
// accounts appear in — so the whole picture is visible without tab-switching.
//
// The offline vault-health report is owned upstream (useVaultData) and refreshed
// after every sync, so this view stays up to date the whole time it's open instead
// of snapshotting once on mount. The at-risk items themselves are now a normal
// vault view (the "At risk" rail filter) — the health summary just links to it via
// `onViewAtRisk`, so the at-risk list shares the vault list's design. Each section
// is its own module under ./security/; this file owns the header + stacked layout.

import { createEffect, createSignal } from 'solid-js';
import { ShieldCheck } from 'lucide-solid';
import type { VaultHealthReport } from '../lib/types.ts';
import BreachMonitor from './security/BreachMonitor.tsx';
import ExposedPasswordsView from './security/ExposedPasswordsView.tsx';
import VaultHealth from './security/VaultHealth.tsx';
import './SecurityCenter.css';

export default function SecurityCenter(props: {
  /** Offline vault-health report, auto-refreshed by the data layer (per sync). */
  report: VaultHealthReport | null;
  onOpenItem: (id: string) => void;
  /** Jump to the "At risk" vault view (the filtered item list). */
  onViewAtRisk: () => void;
}) {
  // "Analysing…" only until the first report lands; after that the live report
  // always renders (it refreshes in place on each sync), never flipping back to a
  // loading state.
  const [everLoaded, setEverLoaded] = createSignal(false);
  createEffect(() => {
    if (props.report) setEverLoaded(true);
  });

  return (
    <div class="sec">
      <header class="sec-header">
        <ShieldCheck size={16} strokeWidth={1.75} />
        <h2>Vault security</h2>
      </header>

      <div class="sec-body">
        <VaultHealth
          report={props.report}
          loading={!everLoaded()}
          onViewAtRisk={() => props.onViewAtRisk()}
        />
        <ExposedPasswordsView onOpenItem={props.onOpenItem} />
        <BreachMonitor />
      </div>
    </div>
  );
}
