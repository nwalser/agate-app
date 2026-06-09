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
  END_COL_PX,
  gridMetrics,
  isFilterable,
  MIN_COL_WIDTH,
  NAME_COL_KEY,
  sortKeyOf,
  TYPE_LABELS,
  type BuiltinColumnId,
  type ColumnConfig,
  type ColumnSpec,
  type GridMetrics,
  type SortDir,
  type SortKey,
} from './columnConfig.ts';

export {
  addCustomColumn,
  columns,
  isColumnVisible,
  isRevealed,
  moveColumn,
  removeColumn,
  reorderColumn,
  resetColumns,
  resetColumnWidth,
  setColumnWidth,
  setFavicons,
  toggleColumn,
  toggleReveal,
} from './columnStorage.ts';
