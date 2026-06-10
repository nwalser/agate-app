// Context→props adapter for the detail pane (same pattern as
// VaultListConnected): the pane stays pure, the screen's capabilities are
// mapped onto its props in exactly one place. The open-detail Show stays in
// Vault.tsx (it also gates on the editor state); this takes the resolved item.

import VaultDetailPane from '../../components/VaultDetailPane.tsx';
import type { ItemDetail } from '../../lib/types.ts';
import { useVault } from './VaultContext.tsx';

export default function VaultDetailPaneConnected(props: { detail: ItemDetail }) {
  const v = useVault();
  return (
    <VaultDetailPane
      detail={props.detail}
      inTrash={v.filtering.inTrash()}
      revealed={v.detailState.revealed()}
      setRevealed={v.detailState.setRevealed}
      totp={v.detailState.totp()}
      selectedSecurity={v.detailState.selectedSecurity()}
      selectedBreaches={v.detailState.selectedBreaches()}
      copy={(label, value) => void v.actions.copy(label, value)}
      onFavorite={(item) => void v.actions.detailFavorite(item)}
      onEdit={(item) => v.actions.openEdit(item)}
      onClone={(id) => void v.actions.detailClone(id)}
      onDelete={(id, permanent) => void v.actions.detailDelete(id, permanent)}
      onRestore={(id) => void v.actions.detailRestore(id)}
    />
  );
}
