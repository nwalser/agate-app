// Display labels for the closed set of item types (the Type column, the type filter
// input, and the editor title). Single source of truth, shared by the vault list,
// the columns store, and the item editor.

import type { ItemType } from './types.ts';
import { t } from './i18n.ts';

// Getters keep the `TYPE_LABELS[type]` access shape while resolving lazily, so the
// value tracks the active locale when read inside Solid JSX.
export const TYPE_LABELS: Record<ItemType, string> = {
  get login() {
    return t('itemType.login');
  },
  get secureNote() {
    return t('itemType.secureNote');
  },
  get card() {
    return t('itemType.card');
  },
  get identity() {
    return t('itemType.identity');
  },
  get sshKey() {
    return t('itemType.sshKey');
  },
  get unknown() {
    return t('itemType.unknown');
  },
};
