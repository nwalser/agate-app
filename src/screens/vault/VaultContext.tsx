// Screen-scoped capability context for the Vault screen — the seam that stops
// every feature from threading 20+ props through Vault.tsx. Vault.tsx builds
// ONE `VaultApi` from its hooks and local closures; connected adapters (e.g.
// VaultListConnected) consume it via `useVault()` and map it onto their PURE
// presentational component's props. Presentational components keep taking
// plain props, so they stay unit-testable without any provider scaffolding;
// new features extend `VaultApi` + an adapter instead of editing the screen's
// wiring block.

import { createContext, useContext, type Accessor, type JSX } from 'solid-js';
import type { useVaultData } from '../../hooks/useVaultData.ts';
import type { useVaultFiltering } from '../../hooks/useVaultFiltering.ts';
import type { useVaultSelection } from '../../hooks/useVaultSelection.ts';
import type { ItemDetailState } from '../../hooks/useItemDetail.ts';
import type { BulkActions } from '../../hooks/useBulkActions.ts';
import type { DetailCache } from '../../state/detailCache.ts';
import type { VaultItem } from '../../lib/types.ts';
import type { ColumnSpec } from '../../state/columns.ts';

export interface VaultApi {
  data: ReturnType<typeof useVaultData>;
  filtering: ReturnType<typeof useVaultFiltering>;
  selection: ReturnType<typeof useVaultSelection>;
  detailState: ItemDetailState;
  actions: BulkActions;
  /** The screen-owned per-row detail cache (list cells + custom-field grouping). */
  rowDetail: DetailCache;
  /** The open item id (screen-local selection signal). */
  selectedId: Accessor<string | null>;
  // ── Screen-level closures (capabilities, not props to drill): ──
  copyCell: (item: VaultItem, col: ColumnSpec) => void;
  openRowCtxMenu: (item: VaultItem, e: MouseEvent) => void;
}

const VaultCtx = createContext<VaultApi>();

export function VaultProvider(props: { api: VaultApi; children: JSX.Element }) {
  return <VaultCtx.Provider value={props.api}>{props.children}</VaultCtx.Provider>;
}

export function useVault(): VaultApi {
  const api = useContext(VaultCtx);
  if (!api) throw new Error('useVault must be used inside <VaultProvider>');
  return api;
}
