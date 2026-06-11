// Pure model for a vault-list column header's context menu. Given what a header is
// capable of (sortable / secret / filterable / groupable / its position), it yields
// the ordered list of menu items with their disabled/danger state and section
// breaks. Kept pure (no signals, no handlers) so the menu's shape is unit-tested in
// isolation; VaultListHeader maps each item id to the matching column mutator.

import type { SortDir } from '../state/columns.ts';
import { t } from './i18n.ts';

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
  | 'configure'
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
  /** A custom-field column — it alone can be configured (display name + icon). */
  custom: boolean;
}

/** The ordered menu items for a header, with disabled/section state resolved. */
export function headerMenuItems(target: HeaderTarget): HeaderMenuItem[] {
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

  if (target.sortable) {
    add('sort-asc', t('headerMenu.sortAscending'), { disabled: target.sorted && target.sortDir === 'asc' });
    add('sort-desc', t('headerMenu.sortDescending'), { disabled: target.sorted && target.sortDir === 'desc' });
  }

  if (target.secret) {
    if (target.revealed) add('hide-values', t('headerMenu.hideValues'), { section: true });
    else add('reveal', t('headerMenu.revealValues'), { section: true });
  }

  if (target.filterable) add('filter', t('headerMenu.filterByColumn'), { section: true });

  if (target.groupable) {
    if (target.grouped) add('ungroup', t('headerMenu.ungroup'), { section: true });
    else add('group', t('headerMenu.groupByColumn'), { section: true });
  }

  if (!target.isName) {
    add('move-left', t('headerMenu.moveLeft'), { disabled: target.index <= 0, section: true });
    add('move-right', t('headerMenu.moveRight'), { disabled: target.index >= target.count - 1 });
  }

  if (target.custom) add('configure', t('headerMenu.configureColumn'), { section: true });

  if (target.hasWidth) add('reset-width', t('headerMenu.resetWidth'), { section: true });

  if (!target.isName) add('hide', t('headerMenu.hideColumn'), { danger: true, section: true });

  return items;
}
