// Bridge between the Vault screen (which owns the commands + decrypted items)
// and the titlebar search field (components/Titlebar.tsx), which lives outside
// the Vault tree in App.tsx. The Vault registers a source on mount; the titlebar
// dropdown reads it to preview items (normal search) or commands (`/` mode).
// In-memory only, never persisted — item names are not secret, but treat this
// like the live vault: cleared when the Vault unmounts (lock/logout).

import { createSignal } from 'solid-js';
import type { Command } from '../lib/command.ts';
import type { VaultItem } from '../lib/types.ts';

export interface PaletteSource {
  /** Action commands shown in `/` command mode (excludes go-to-item entries). */
  commands: Command[];
  /** Live, non-deleted items shown as the normal-search preview. */
  items: VaultItem[];
  /** Jump to an item by id (selects it in the all-items view). */
  openItem: (id: string) => void;
}

const EMPTY: PaletteSource = { commands: [], items: [], openItem: () => {} };

const [paletteSource, setPaletteSource] = createSignal<PaletteSource>(EMPTY);

/** Reset to the empty source — call when the Vault unmounts. */
function clearPaletteSource() {
  setPaletteSource(EMPTY);
}

export { paletteSource, setPaletteSource, clearPaletteSource };
