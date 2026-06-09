// Pure model for a vault-list column header's context menu. Given what a header is
// capable of (sortable / secret / filterable / groupable / its position), it yields
// the ordered list of menu items with their disabled/danger state and section
// breaks. Kept pure (no signals, no handlers) so the menu's shape is unit-tested in
// isolation; VaultListHeader maps each item id to the matching column mutator.

import type { SortDir } from '../state/columns.ts';

export type HeaderMenuItemId =
  | 'sort-asc'
  | 'sort-desc'
  | 'reveal'
  | 'hide-values'
  | 'filter'
  | 'group'
  | 'ungroup'
  | 'move-left'
  | 'move-right'
  | 'reset-width'
  | 'hide';

export interface HeaderMenuItem {
  id: HeaderMenuItemId;
  label: string;
  disabled: boolean;
  danger: boolean;
  /** Render a separator before this item (it starts a new logical section). */
  section: boolean;
}

/** Everything the menu model needs about the clicked header. */
export interface HeaderTarget {
  /** The always-on Name column — it can't be moved, hidden, revealed, or grouped. */
  isName: boolean;
  /** Position among the configurable data columns (Name → -1). */
  index: number;
  /** Number of configurable data columns. */
  count: number;
  sortable: boolean;
  /** This column is the active sort column. */
  sorted: boolean;
  sortDir: SortDir;
  secret: boolean;
  revealed: boolean;
  filterable: boolean;
  groupable: boolean;
  /** This column is the active group-by. */
  grouped: boolean;
  /** A custom drag-width is set for this column. */
  hasWidth: boolean;
}

/** The ordered menu items for a header, with disabled/section state resolved. */
export function headerMenuItems(t: HeaderTarget): HeaderMenuItem[] {
  const items: HeaderMenuItem[] = [];
  const add = (
    id: HeaderMenuItemId,
    label: string,
    opts: { disabled?: boolean; danger?: boolean; section?: boolean } = {},
  ) => {
    // A section break only matters once there's already an item above it.
    items.push({
      id,
      label,
      disabled: opts.disabled ?? false,
      danger: opts.danger ?? false,
      section: (opts.section ?? false) && items.length > 0,
    });
  };

  if (t.sortable) {
    add('sort-asc', 'Sort ascending', { disabled: t.sorted && t.sortDir === 'asc' });
    add('sort-desc', 'Sort descending', { disabled: t.sorted && t.sortDir === 'desc' });
  }

  if (t.secret) {
    if (t.revealed) add('hide-values', 'Hide values', { section: true });
    else add('reveal', 'Reveal values', { section: true });
  }

  if (t.filterable) add('filter', 'Filter by this column', { section: true });

  if (t.groupable) {
    if (t.grouped) add('ungroup', 'Ungroup', { section: true });
    else add('group', 'Group by this column', { section: true });
  }

  if (!t.isName) {
    add('move-left', 'Move left', { disabled: t.index <= 0, section: true });
    add('move-right', 'Move right', { disabled: t.index >= t.count - 1 });
  }

  if (t.hasWidth) add('reset-width', 'Reset width', { section: true });

  if (!t.isName) add('hide', 'Hide column', { danger: true, section: true });

  return items;
}
