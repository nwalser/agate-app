// The closed set of custom-column icon ids — the PURE half (no lucide imports), so
// the column schema/store (`state/columnConfig.ts`, `columnStorage.ts`) can validate
// a persisted icon id at the storage boundary without dragging the whole lucide icon
// set into their module graph (which would slow every `vi.resetModules()` reload).
// The id → component mapping lives in `columnIcons.ts`, used only by the UI.

export const COLUMN_ICON_IDS = [
  'tag',
  'hash',
  'mail',
  'at-sign',
  'phone',
  'globe',
  'link',
  'calendar',
  'map-pin',
  'user',
  'building',
  'briefcase',
  'key',
  'lock',
  'fingerprint',
  'shield',
  'credit-card',
  'banknote',
  'wallet',
  'star',
  'bookmark',
  'flag',
  'file-text',
  'server',
  'database',
  'smartphone',
] as const;

export type ColumnIconId = (typeof COLUMN_ICON_IDS)[number];

const SET = new Set<string>(COLUMN_ICON_IDS);

/** Trust-boundary guard: is `v` one of the known icon ids? */
export function isColumnIconId(v: unknown): v is ColumnIconId {
  return typeof v === 'string' && SET.has(v);
}
