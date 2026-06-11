// UI constants + small pure helpers for the Vault screen: the item types offered
// in the Add menu / command palette, the left-rail type filters, filter equality,
// the inline-editor open-state shape, and the background auto-sync interval. Kept
// out of the screen component so the hooks/subcomponents can share them without a
// circular import back into Vault.tsx.

import type { ItemDetail, ItemType } from './types.ts';
import type { VaultFilter } from './search.ts';
import type { ItemTemplate } from './templates.ts';
import { t } from './i18n.ts';

// Item types offered in the "Add" menu and command palette (excludes 'unknown').
// Each `label` is a getter so it tracks the active locale when read in JSX.
export const CREATE_TYPES: { type: ItemType; label: string }[] = [
  { type: 'login', get label() { return t('itemType.login'); } },
  { type: 'card', get label() { return t('itemType.card'); } },
  { type: 'identity', get label() { return t('itemType.identity'); } },
  { type: 'secureNote', get label() { return t('itemType.secureNote'); } },
  { type: 'sshKey', get label() { return t('itemType.sshKey'); } },
];

// Singular create label for a type (e.g. the per-page "Add login" button).
export const createLabel = (type: ItemType): string =>
  CREATE_TYPES.find((c) => c.type === type)?.label ?? t('itemType.itemFallback');

// Left-rail filters. `unknown` items only appear under "All items".
export const TYPE_FILTERS: { type: ItemType; label: string }[] = [
  { type: 'login', get label() { return t('itemType.loginsPlural'); } },
  { type: 'card', get label() { return t('itemType.cardsPlural'); } },
  { type: 'identity', get label() { return t('itemType.identitiesPlural'); } },
  { type: 'secureNote', get label() { return t('itemType.secureNotesPlural'); } },
  { type: 'sshKey', get label() { return t('itemType.sshKeysPlural'); } },
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
