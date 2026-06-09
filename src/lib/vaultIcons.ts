// Single source for the item-type -> icon mapping. Shared by the vault list, the
// vault screen, and the titlebar search preview so a given item type renders the same
// icon everywhere.

import { CreditCard, File, KeyRound, StickyNote, Terminal, UserRound } from 'lucide-solid';
import type { ItemType } from './types.ts';
import type { IconComponent } from './icon.ts';

export function typeIcon(t: ItemType): IconComponent {
  switch (t) {
    case 'login':
      return KeyRound;
    case 'secureNote':
      return StickyNote;
    case 'card':
      return CreditCard;
    case 'identity':
      return UserRound;
    case 'sshKey':
      return Terminal;
    default:
      return File;
  }
}
