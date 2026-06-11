// Vault-list column configuration — public barrel. Not secret: persisted in
// localStorage (a UI preference, not the keychain). The implementation is split
// into two cohesive halves, re-exported here so every existing importer keeps
// working unchanged:
//   - columnConfig.ts  — immutable schema, metadata, key/label/sort helpers, grid
//                         track math, and the validating parse (pure, no signals).
//   - columnStorage.ts — the reactive `columns` signal + mutators + localStorage.

export {
  ALL_BUILTINS,
  builtinMeta,
  CHECK_COL_PX,
  COL_GAP,
  columnKey,
  columnLabel,
  columnTrack,
  DISPLAY_MODES,
  END_COL_PX,
  gridMetrics,
  GROUP_KEYS,
  GROUP_LABELS,
  groupSpecKey,
  groupSpecOf,
  isFilterable,
  MIN_COL_WIDTH,
  NAME_COL_KEY,
  sortKeyOf,
  TYPE_LABELS,
  type BuiltinColumnId,
  parseColumnConfig,
  type ColumnConfig,
  type ColumnSpec,
  type DisplayMode,
  type GridMetrics,
  type GroupKey,
  type GroupSpec,
  type SortDir,
  type SortKey,
} from './columnConfig.ts';

export {
  addCustomColumn,
  applyColumnConfig,
  columns,
  configureColumn,
  isColumnVisible,
  isRevealed,
  moveColumn,
  removeColumn,
  reorderColumn,
  resetColumns,
  resetColumnWidth,
  setColumnWidth,
  setDisplayMode,
  setFavicons,
  setGroupBy,
  toggleColumn,
  toggleReveal,
} from './columnStorage.ts';
