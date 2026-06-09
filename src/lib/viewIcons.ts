// Curated icon set for saved views (sidebar). A view stores an icon *id* (a stable
// string, persisted) which maps to a lucide component here. Kept small + closed so
// the Settings picker is a tidy grid and an unknown/legacy id falls back cleanly.

import {
  Bookmark,
  Briefcase,
  Globe,
  KeyRound,
  FolderClosed,
  Lock,
  Mail,
  Shield,
  Star,
  Tag,
  UserRound,
  Wallet,
} from 'lucide-solid';
import type { IconComponent } from './icon.ts';

/** id → icon component. `bookmark` is the default / legacy fallback. */
const ICONS: Record<string, IconComponent> = {
  bookmark: Bookmark,
  star: Star,
  shield: Shield,
  key: KeyRound,
  globe: Globe,
  folder: FolderClosed,
  tag: Tag,
  wallet: Wallet,
  mail: Mail,
  user: UserRound,
  briefcase: Briefcase,
  lock: Lock,
};

/** The default view icon id (also the fallback for unknown/legacy ids). */
export const DEFAULT_VIEW_ICON = 'bookmark';

/** Picker order for Settings (insertion order of `ICONS`). */
export const VIEW_ICONS: { id: string; icon: IconComponent }[] = Object.entries(ICONS).map(
  ([id, icon]) => ({ id, icon }),
);

/** True for a known icon id. */
export function isViewIcon(v: unknown): v is string {
  return typeof v === 'string' && v in ICONS;
}

/** Resolve an icon id to its component, falling back to the bookmark. */
export function viewIcon(id: string | undefined): IconComponent {
  return (id && ICONS[id]) || ICONS[DEFAULT_VIEW_ICON];
}
