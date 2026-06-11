// Settings › Sidebar — customize the left nav rail: reorder entries (drag or
// arrows), show/hide any entry, add divider lines, and manage saved VIEWS. A view
// here is only created/renamed/re-iconed (name + icon) + reordered/deleted — its
// actual list configuration (filter, search, per-column filters, column layout,
// sort) is captured while *viewing* it (the "Save changes" bar on the vault
// screen). Reads/writes the sidebar store (state/sidebar.ts); the rail re-renders
// live. Settings stays bottom-pinned and is not listed here.

import { createSignal, For, Show } from 'solid-js';
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, Minus, Pencil, Plus, Trash2, X } from 'lucide-solid';
import type { IconComponent } from '../../lib/icon.ts';
import { t } from '../../lib/i18n.ts';
import { ResetButton } from '../../components/settings/SettingsControls.tsx';
import { entryMeta, isBuiltinId, isDividerId } from '../../lib/sidebarConfig.ts';
import { DEFAULT_VIEW_ICON, VIEW_ICONS, viewIcon } from '../../lib/viewIcons.ts';
import {
  addDivider,
  addQuery,
  isHidden,
  moveEntry,
  queryById,
  removeEntry,
  removeQuery,
  reorderEntry,
  resetSidebar,
  setDividerLabel,
  sidebar,
  toggleHidden,
  updateQuery,
} from '../../state/sidebar.ts';
import { useDragReorder } from '../../hooks/useDragReorder.ts';
import './SidebarSettings.css';

function resolveRow(id: string): { label: string; icon: IconComponent } {
  if (isBuiltinId(id)) return entryMeta(id);
  if (isDividerId(id)) return { label: t('sidebarSettings.divider'), icon: Minus };
  const q = queryById(id);
  return { label: q?.name ?? id, icon: viewIcon(q?.icon) };
}

export default function SidebarSettings() {
  // Drag-reorder via the shared grip-handle + insert-line hook (mirrors ColumnMenu).
  const reorder = useDragReorder({ onReorder: reorderEntry });
  const entryCount = () => sidebar().order.length;

  // View add/edit form state. editId === null → adding a new view.
  const [editId, setEditId] = createSignal<string | null>(null);
  const [name, setName] = createSignal('');
  const [icon, setIcon] = createSignal<string>(DEFAULT_VIEW_ICON);

  function resetForm() {
    setEditId(null);
    setName('');
    setIcon(DEFAULT_VIEW_ICON);
  }

  function beginEdit(id: string) {
    const q = queryById(id);
    if (!q) return;
    setEditId(id);
    setName(q.name);
    setIcon(q.icon);
  }

  function submit(e: Event) {
    e.preventDefault();
    if (!name().trim()) return;
    const id = editId();
    if (id) updateQuery(id, { name: name(), icon: icon() });
    else addQuery({ name: name(), icon: icon() });
    resetForm();
  }

  const views = () => sidebar().queries;

  return (
    <div class="settings-page sidebar-settings">
      <section class="settings-section">
        <h3>{t('sidebarSettings.entriesTitle')}</h3>
        <p class="muted settings-help">{t('sidebarSettings.entriesHelp')}</p>
        <For each={sidebar().order}>
          {(id, i) => {
            const row = resolveRow(id);
            const Icon = row.icon;
            return (
              <div
                class="sb-row"
                classList={{
                  dragging: reorder.dragIndex() === i(),
                  'drop-above': reorder.gap() === i() && reorder.dragIndex() !== null,
                  'drop-below':
                    i() === entryCount() - 1 &&
                    reorder.gap() === entryCount() &&
                    reorder.dragIndex() !== null,
                  hidden: isHidden(id),
                }}
                {...reorder.rowProps(i)}
              >
                <span class="sb-grip" title={t('sidebarSettings.dragToReorder')} {...reorder.handleProps(i)}>
                  <GripVertical size={14} />
                </span>
                <Icon size={15} strokeWidth={1.6} class="sb-row-icon" />
                <Show when={isDividerId(id)} fallback={<span class="sb-name">{row.label}</span>}>
                  <input
                    class="sb-input sb-divider-input"
                    placeholder={t('sidebarSettings.sectionHeaderPlaceholder')}
                    value={sidebar().dividerLabels[id] ?? ''}
                    onInput={(e) => setDividerLabel(id, e.currentTarget.value)}
                  />
                </Show>
                <button
                  class="ghost icon-btn sb-btn"
                  title={t('sidebarSettings.moveUp')}
                  disabled={i() === 0}
                  onClick={() => moveEntry(i(), -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  class="ghost icon-btn sb-btn"
                  title={t('sidebarSettings.moveDown')}
                  disabled={i() === sidebar().order.length - 1}
                  onClick={() => moveEntry(i(), 1)}
                >
                  <ArrowDown size={14} />
                </button>
                <Show
                  when={isDividerId(id)}
                  fallback={
                    <button
                      class="ghost icon-btn sb-btn"
                      title={isHidden(id) ? t('common.show') : t('common.hide')}
                      onClick={() => toggleHidden(id)}
                    >
                      <Show when={isHidden(id)} fallback={<Eye size={14} />}>
                        <EyeOff size={14} />
                      </Show>
                    </button>
                  }
                >
                  <button class="ghost icon-btn sb-btn" title={t('sidebarSettings.removeDivider')} onClick={() => removeEntry(id)}>
                    <Trash2 size={14} />
                  </button>
                </Show>
              </div>
            );
          }}
        </For>
        <button class="sb-add-divider" onClick={() => addDivider()}>
          <Minus size={14} /> {t('sidebarSettings.addDivider')}
        </button>
      </section>

      <section class="settings-section">
        <h3>{t('sidebarSettings.savedViewsTitle')}</h3>
        <p class="muted settings-help">{t('sidebarSettings.savedViewsHelp')}</p>

        <Show when={views().length > 0}>
          <div class="sb-queries">
            <For each={views()}>
              {(q) => {
                const Icon = viewIcon(q.icon);
                return (
                  <div class="sb-query">
                    <Icon size={15} strokeWidth={1.6} class="sb-row-icon" />
                    <div class="sb-query-text">
                      <span class="sb-query-name">{q.name}</span>
                      <span class="sb-query-sub muted">{t('sidebarSettings.viewLabel')}</span>
                    </div>
                    <button class="ghost icon-btn sb-btn" title={t('common.edit')} onClick={() => beginEdit(q.id)}>
                      <Pencil size={14} />
                    </button>
                    <button
                      class="ghost icon-btn sb-btn"
                      title={t('common.delete')}
                      onClick={() => {
                        if (editId() === q.id) resetForm();
                        removeQuery(q.id);
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>

        <form class="sb-form" onSubmit={submit}>
          <div class="sb-form-head">
            <span class="sb-form-title">{editId() ? t('sidebarSettings.editView') : t('sidebarSettings.newView')}</span>
            <Show when={editId()}>
              <button type="button" class="ghost icon-btn sb-btn" title={t('sidebarSettings.cancelEdit')} onClick={resetForm}>
                <X size={14} />
              </button>
            </Show>
          </div>
          <input
            class="sb-input"
            placeholder={t('sidebarSettings.namePlaceholder')}
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
          />
          <div class="sb-icon-grid" role="group" aria-label={t('sidebarSettings.iconGroupLabel')}>
            <For each={VIEW_ICONS}>
              {(opt) => {
                const Icon = opt.icon;
                return (
                  <button
                    type="button"
                    class="sb-icon-btn"
                    classList={{ active: icon() === opt.id }}
                    aria-pressed={icon() === opt.id}
                    title={opt.id}
                    onClick={() => setIcon(opt.id)}
                  >
                    <Icon size={16} strokeWidth={1.6} />
                  </button>
                );
              }}
            </For>
          </div>
          <button type="submit" class="sb-add" disabled={!name().trim()}>
            <Plus size={14} /> {editId() ? t('sidebarSettings.saveView') : t('sidebarSettings.addView')}
          </button>
        </form>
      </section>

      <div class="settings-actions">
        <ResetButton label={t('sidebarSettings.resetToDefault')} onClick={() => resetSidebar()} />
      </div>
    </div>
  );
}
