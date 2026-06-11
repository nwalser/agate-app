// Context→props adapter for the vault list. VaultList itself stays pure (plain
// props, no provider needed in its unit tests); this is the ONE place its props
// are sourced from the screen's capabilities. Adding a list feature = extend
// VaultApi + this mapping — Vault.tsx's wiring stays untouched.

import VaultList from '../../components/VaultList.tsx';
import { useVault } from './VaultContext.tsx';
import { t } from '../../lib/i18n.ts';

export default function VaultListConnected() {
  const v = useVault();
  return (
    <VaultList
      items={v.filtering.displayed()}
      folders={v.data.folders()}
      sortKey={v.filtering.sortKey()}
      sortDir={v.filtering.sortDir()}
      onSort={v.filtering.toggleSort}
      onSetSort={v.filtering.setSort}
      selectedId={v.selectedId()}
      selectedCount={v.selection.selectedCount()}
      isSelected={v.selection.isSelected}
      cursorId={v.selection.cursorId()}
      onRowClick={v.selection.onRowClick}
      onRowContextMenu={v.openRowCtxMenu}
      onCheckboxToggle={v.selection.onCheckboxToggle}
      onCopyCell={v.copyCell}
      onOpenWebsite={(item) => void v.actions.openSiteFor(item)}
      onListKeyDown={v.selection.handleListKeyDown}
      onMarqueeSelect={v.selection.marqueeSelect}
      enableItemDrag={v.filtering.filter().kind !== 'trash'}
      onCreateItem={(type) => v.actions.openCreate(type)}
      onSelectAll={v.selection.selectAll}
      emptyMessage={v.data.items().length === 0 ? t('vault.emptyVault') : t('vault.noMatches')}
      cacheToken={v.actions.cacheToken()}
      security={v.data.health()}
      detailCache={v.rowDetail}
    />
  );
}
