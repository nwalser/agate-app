// Display labels for the closed set of item types (the Type column, the type filter
// input, and the editor title). Single source of truth, shared by the vault list,
// the columns store, and the item editor.

import type { ItemType } from './types.ts';

export const TYPE_LABELS: Record<ItemType, string> = {
  login: 'Login',
  secureNote: 'Secure note',
  card: 'Card',
  identity: 'Identity',
  sshKey: 'SSH key',
  unknown: 'Item',
};
