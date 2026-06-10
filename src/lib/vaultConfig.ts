// UI constants + small pure helpers for the Vault screen: the item types offered
// in the Add menu / command palette, the left-rail type filters, filter equality,
// the inline-editor open-state shape, and the background auto-sync interval. Kept
// out of the screen component so the hooks/subcomponents can share them without a
// circular import back into Vault.tsx.

import type { ItemDetail, ItemType } from './types.ts';
import type { VaultFilter } from './search.ts';
import type { ItemTemplate } from './templates.ts';

// Item types offered in the "Add" menu and command palette (excludes 'unknown').
export const CREATE_TYPES: { type: ItemType; label: string }[] = [
  { type: 'login', label: 'Login' },
  { type: 'card', label: 'Card' },
  { type: 'identity', label: 'Identity' },
  { type: 'secureNote', label: 'Secure note' },
  { type: 'sshKey', label: 'SSH key' },
];

// Singular create label for a type (e.g. the per-page "Add login" button).
export const createLabel = (t: ItemType): string =>
  CREATE_TYPES.find((c) => c.type === t)?.label ?? 'item';

// Left-rail filters. `unknown` items only appear under "All items".
export const TYPE_FILTERS: { type: ItemType; label: string }[] = [
  { type: 'login', label: 'Logins' },
  { type: 'card', label: 'Cards' },
  { type: 'identity', label: 'Identities' },
  { type: 'secureNote', label: 'Secure notes' },
  { type: 'sshKey', label: 'SSH keys' },
];

export function filterEq(a: VaultFilter, b: VaultFilter): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'type' && b.kind === 'type') return a.itemType === b.itemType;
  if (a.kind === 'folder' && b.kind === 'folder') return a.folderId === b.folderId;
  return true;
}

// Editor open-state: closed, creating a fresh item (optionally from a template
// that pre-fills the form), or editing an existing one.
export type EditorState =
  | { mode: 'closed' }
  | { mode: 'create'; createType: ItemType; template?: ItemTemplate }
  | { mode: 'edit'; item: ItemDetail };

// Automatic background sync interval: once on open, then on this fixed cadence.
export const AUTO_SYNC_MS = 5 * 60 * 1000;

// Which main view occupies the body next to the left rail. The rail stays visible
// in every view; `vault` is the item list + detail.
export type VaultView = 'vault' | 'security' | 'sync' | 'generator' | 'sends';
