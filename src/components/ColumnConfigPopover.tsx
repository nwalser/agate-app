// Configure a custom-field column: its display name + an icon. Two modes share one
// popover so the create flow (from the add-column menu) and the edit flow (from a
// column header's "Configure…" menu) look and behave identically:
//   - create: type/pick the underlying field name, then a friendly name + icon →
//             addCustomColumn(field, { label, icon }).
//   - edit:   the field is fixed (identity); change the name + icon →
//             configureColumn('custom:<field>', { label, icon }).
// Portaled to <body> + positioned from a point (the trigger's rect / cursor) so it
// escapes the list's scroll-clip, mirroring AddColumnMenu. Reuses VaultList.css.

import { createSignal, For, Show } from 'solid-js';
import { Dynamic, Portal } from 'solid-js/web';
import { Ban, Check } from 'lucide-solid';
import { COLUMN_ICONS } from '../lib/columnIcons.ts';
import { addCustomColumn, columnKey, configureColumn } from '../state/columns.ts';
import { t } from '../lib/i18n.ts';

type Mode =
  | { mode: 'create'; suggestions: string[] }
  | { mode: 'edit'; field: string; label?: string; icon?: string };

export type ColumnConfigPopoverProps = Mode & {
  /** Anchor point (viewport coords) — the trigger button's corner or the cursor. */
  at: { x: number; y: number };
  onClose: () => void;
};

export default function ColumnConfigPopover(props: ColumnConfigPopoverProps) {
  const initialField = props.mode === 'edit' ? props.field : '';
  const initialLabel = props.mode === 'edit' ? (props.label ?? '') : '';
  const initialIcon = props.mode === 'edit' ? (props.icon ?? null) : null;

  const [field, setField] = createSignal(initialField);
  const [label, setLabel] = createSignal(initialLabel);
  const [icon, setIcon] = createSignal<string | null>(initialIcon);

  // Clamp the box to the viewport (260px wide, generous tall estimate).
  const left = Math.max(8, Math.min(props.at.x, window.innerWidth - 260 - 8));
  const top = Math.max(8, Math.min(props.at.y, window.innerHeight - 360));

  const canSubmit = () => (props.mode === 'edit' ? true : field().trim().length > 0);

  function submit(e: Event) {
    e.preventDefault();
    if (!canSubmit()) return;
    const meta = { label: label().trim() || null, icon: icon() };
    if (props.mode === 'edit') {
      configureColumn(columnKey({ kind: 'custom', field: props.field }), meta);
    } else {
      const f = field().trim();
      if (!f) return;
      addCustomColumn(f, { label: meta.label ?? undefined, icon: meta.icon ?? undefined });
    }
    props.onClose();
  }

  return (
    <Portal>
      <div class="vault-menu-backdrop" onClick={() => props.onClose()} />
      <form
        class="column-cfg-menu"
        role="menu"
        style={{ top: `${top}px`, left: `${left}px` }}
        onSubmit={submit}
      >
        <div class="column-add-label">
          {props.mode === 'edit' ? t('columnConfig.editTitle') : t('columnConfig.createTitle')}
        </div>

        <Show
          when={props.mode === 'create'}
          fallback={<div class="column-cfg-field-name">{initialField}</div>}
        >
          <label class="column-cfg-row">
            <span class="column-cfg-row-label">{t('columnConfig.field')}</span>
            <input
              list="column-cfg-field-suggestions"
              placeholder={t('columnConfig.fieldPlaceholder')}
              value={field()}
              onInput={(e) => setField(e.currentTarget.value)}
              autofocus
            />
          </label>
          <datalist id="column-cfg-field-suggestions">
            <For each={props.mode === 'create' ? props.suggestions : []}>
              {(s) => <option value={s} />}
            </For>
          </datalist>
        </Show>

        <label class="column-cfg-row">
          <span class="column-cfg-row-label">{t('columnConfig.name')}</span>
          <input
            placeholder={field().trim() || t('columnConfig.namePlaceholder')}
            value={label()}
            onInput={(e) => setLabel(e.currentTarget.value)}
          />
        </label>

        <div class="column-cfg-row-label column-cfg-icon-head">{t('columnConfig.icon')}</div>
        <div class="column-cfg-icons">
          <button
            type="button"
            class="column-cfg-icon"
            classList={{ selected: icon() === null }}
            title={t('columnConfig.noIcon')}
            onClick={() => setIcon(null)}
          >
            <Ban size={15} />
          </button>
          <For each={COLUMN_ICONS}>
            {(def) => (
              <button
                type="button"
                class="column-cfg-icon"
                classList={{ selected: icon() === def.id }}
                title={def.label}
                onClick={() => setIcon(def.id)}
              >
                <Dynamic component={def.icon} size={15} />
              </button>
            )}
          </For>
        </div>

        <div class="column-add-sep" />
        <button type="submit" class="column-cfg-save" disabled={!canSubmit()}>
          <Check size={14} /> {props.mode === 'edit' ? t('columnConfig.save') : t('columnConfig.add')}
        </button>
      </form>
    </Portal>
  );
}
