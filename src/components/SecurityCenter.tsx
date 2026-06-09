// Security center: a single-page dashboard that stacks every security view —
// vault health, exposed passwords, the dark-web monitor, and the breaches your
// accounts appear in — so the whole picture is visible without tab-switching.
// Each section is its own module under ./security/; this file owns only the
// header and the stacked layout. The .sec-* CSS shared by all the subviews is
// imported here. Keeps its default export + props identical so its caller
// doesn't change.

import { ShieldCheck } from 'lucide-solid';
import BreachDirectory from './security/BreachDirectory.tsx';
import DarkWebBreachView from './security/DarkWebBreachView.tsx';
import ExposedPasswordsView from './security/ExposedPasswordsView.tsx';
import VaultHealth from './security/VaultHealth.tsx';
import './SecurityCenter.css';

export default function SecurityCenter(props: { onOpenItem: (id: string) => void }) {
  return (
    <div class="sec">
      <header class="sec-header">
        <ShieldCheck size={16} strokeWidth={1.75} />
        <h2>Vault security</h2>
      </header>

      <div class="sec-body">
        <VaultHealth onOpenItem={props.onOpenItem} />
        <ExposedPasswordsView onOpenItem={props.onOpenItem} />
        <DarkWebBreachView />
        <BreachDirectory />
      </div>
    </div>
  );
}
