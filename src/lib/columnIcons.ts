// Custom-column icon set — the UI half: id → lucide component + picker label. Used
// only by the column config popover (the picker) and the list header (rendering the
// chosen icon). The pure id set + the storage-boundary guard live in
// `columnIconIds.ts` so the schema/store never import lucide. lucide-solid only —
// never emojis (CLAUDE.md).

import {
  AtSign,
  Banknote,
  Bookmark,
  Briefcase,
  Building2,
  Calendar,
  CreditCard,
  Database,
  FileText,
  Fingerprint,
  Flag,
  Globe,
  Hash,
  Key,
  Link,
  Lock,
  Mail,
  MapPin,
  Phone,
  Server,
  Shield,
  Smartphone,
  Star,
  Tag,
  User,
  Wallet,
} from 'lucide-solid';
import type { IconComponent } from './icon.ts';
import { COLUMN_ICON_IDS, type ColumnIconId } from './columnIconIds.ts';

export { isColumnIconId, type ColumnIconId } from './columnIconIds.ts';

export interface ColumnIconDef {
  /** Stable id persisted in the column config (never the component identity). */
  id: ColumnIconId;
  /** Human label for the picker tooltip. */
  label: string;
  icon: IconComponent;
}

// id → (label, component). Typed by `ColumnIconId`, so the id set and this map can
// never drift: a new id forces an entry here, a stray entry won't compile.
const META: Record<ColumnIconId, { label: string; icon: IconComponent }> = {
  tag: { label: 'Tag', icon: Tag },
  hash: { label: 'Number', icon: Hash },
  mail: { label: 'Email', icon: Mail },
  'at-sign': { label: 'Handle', icon: AtSign },
  phone: { label: 'Phone', icon: Phone },
  globe: { label: 'Website', icon: Globe },
  link: { label: 'Link', icon: Link },
  calendar: { label: 'Date', icon: Calendar },
  'map-pin': { label: 'Location', icon: MapPin },
  user: { label: 'Person', icon: User },
  building: { label: 'Company', icon: Building2 },
  briefcase: { label: 'Work', icon: Briefcase },
  key: { label: 'Key', icon: Key },
  lock: { label: 'Secret', icon: Lock },
  fingerprint: { label: 'Identity', icon: Fingerprint },
  shield: { label: 'Security', icon: Shield },
  'credit-card': { label: 'Card', icon: CreditCard },
  banknote: { label: 'Money', icon: Banknote },
  wallet: { label: 'Wallet', icon: Wallet },
  star: { label: 'Star', icon: Star },
  bookmark: { label: 'Bookmark', icon: Bookmark },
  flag: { label: 'Flag', icon: Flag },
  'file-text': { label: 'Note', icon: FileText },
  server: { label: 'Server', icon: Server },
  database: { label: 'Database', icon: Database },
  smartphone: { label: 'Device', icon: Smartphone },
};

/** The pickable icons, in display order. */
export const COLUMN_ICONS: ColumnIconDef[] = COLUMN_ICON_IDS.map((id) => ({ id, ...META[id] }));

const BY_ID = new Map<string, IconComponent>(COLUMN_ICONS.map((d) => [d.id, d.icon]));

/** Resolve an icon id to its component, or null for none/unknown (forgiving:
 *  a config carrying a removed icon id renders without an icon, never crashes). */
export function columnIcon(id: string | null | undefined): IconComponent | null {
  return id ? BY_ID.get(id) ?? null : null;
}
