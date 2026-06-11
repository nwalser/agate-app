// Vault Cleanup: a dashboard for maintenance tools that keep the vault tidy
// (distinct from the Security center). Today it hosts the link-health checker;
// it's laid out to stack more cleanup tools (duplicates, empty/unused items) later.
// This file owns the header + stacked layout; each tool is its own module under
// ./cleanup/.

import { Sparkles } from 'lucide-solid';
import { t } from '../lib/i18n.ts';
import LinkHealth from './cleanup/LinkHealth.tsx';
import './CleanupCenter.css';

export default function CleanupCenter(props: { onOpenItem: (id: string) => void }) {
  return (
    <div class="clean">
      <header class="clean-header">
        <Sparkles size={16} strokeWidth={1.75} />
        <h2>{t('cleanup.title')}</h2>
      </header>

      <div class="clean-body">
        <LinkHealth onOpenItem={props.onOpenItem} />
      </div>
    </div>
  );
}
