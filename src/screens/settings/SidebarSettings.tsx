// Settings › Sidebar — customize the left nav rail: reorder entries (drag or
// arrows), show/hide any entry, add divider lines, and manage saved VIEWS. A view
// here is only created/renamed/re-iconed (name + icon) + reordered/deleted — its
// actual list configuration (filter, search, per-column filters, column layout,
// sort) is captured while *viewing* it (the "Save changes" bar on the vault
// screen). Reads/writes the sidebar store (state/sidebar.ts); the rail re-renders
// live. Settings stays bottom-pinned and is not listed here.

import { createSignal, For, Show } from 'solid-js';
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, Minus, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-solid';
import type { IconComponent } from '../../lib/icon.ts';
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
  sidebar,
  toggleHidden,
  updateQuery,
} from '../../state/sidebar.ts';
import './SidebarSettings.css';

function resolveRow(id: string): { label: string; icon: IconComponent } {
  if (isBuiltinId(id)) return entryMeta(id);
  if (isDividerId(id)) return { label: 'Divider', icon: Minus };
  const q = queryById(id);
  return { label: q?.name ?? id, icon: viewIcon(q?.icon) };
}

export default function SidebarSettings() {
  // Drag-reorder state (mirrors ColumnMenu): the dragged row + the hovered row.
  const [dragIdx, setDragIdx] = createSignal<number | null>(null);
  const [overIdx, setOverIdx] = createSignal<number | null>(null);

  function drop(target: number) {
    const from = dragIdx();
    if (from !== null && from !== target) reorderEntry(from, target);
    setDragIdx(null);
    setOverIdx(null);
  }

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
        <h3>Sidebar entries</h3>
        <p class="muted settings-help">
          Drag to reorder, or use the arrows. Hide entries you don't use — Settings always stays
          pinned at the bottom.
        </p>
        <For each={sidebar().order}>
          {(id, i) => {
            const row = resolveRow(id);
            const Icon = row.icon;
            return (
              <div
                class="sb-row"
                classList={{
                  dragging: dragIdx() === i(),
                  dropover: overIdx() === i() && dragIdx() !== i(),
                  hidden: isHidden(id),
                }}
                draggable={true}
                onDragStart={(e) => {
                  setDragIdx(i());
                  e.dataTransfer?.setData('text/plain', String(i()));
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverIdx(i());
                  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(i());
                }}
                onDragEnd={() => {
                  setDragIdx(null);
                  setOverIdx(null);
                }}
              >
                <span class="sb-grip" title="Drag to reorder" aria-hidden="true">
                  <GripVertical size={14} />
                </span>
                <Icon size={15} strokeWidth={1.6} class="sb-row-icon" />
                <span class="sb-name">{row.label}</span>
                <button
                  class="ghost icon-btn sb-btn"
                  title="Move up"
                  disabled={i() === 0}
                  onClick={() => moveEntry(i(), -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  class="ghost icon-btn sb-btn"
                  title="Move down"
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
                      title={isHidden(id) ? 'Show' : 'Hide'}
                      onClick={() => toggleHidden(id)}
                    >
                      <Show when={isHidden(id)} fallback={<Eye size={14} />}>
                        <EyeOff size={14} />
                      </Show>
                    </button>
                  }
                >
                  <button class="ghost icon-btn sb-btn" title="Remove divider" onClick={() => removeEntry(id)}>
                    <Trash2 size={14} />
                  </button>
                </Show>
              </div>
            );
          }}
        </For>
        <button class="sb-add-divider" onClick={() => addDivider()}>
          <Minus size={14} /> Add divider
        </button>
      </section>

      <section class="settings-section">
        <h3>Saved views</h3>
        <p class="muted settings-help">
          Pin a view to the rail. Set its name + icon here; configure what it shows (filter,
          search, columns, sort) while viewing it, then hit “Save changes”.
        </p>

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
                      <span class="sb-query-sub muted">View</span>
                    </div>
                    <button class="ghost icon-btn sb-btn" title="Edit" onClick={() => beginEdit(q.id)}>
                      <Pencil size={14} />
                    </button>
                    <button
                      class="ghost icon-btn sb-btn"
                      title="Delete"
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
            <span class="sb-form-title">{editId() ? 'Edit view' : 'New view'}</span>
            <Show when={editId()}>
              <button type="button" class="ghost icon-btn sb-btn" title="Cancel edit" onClick={resetForm}>
                <X size={14} />
              </button>
            </Show>
          </div>
          <input
            class="sb-input"
            placeholder="Name (e.g. AWS logins)"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
          />
          <div class="sb-icon-grid" role="group" aria-label="Icon">
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
            <Plus size={14} /> {editId() ? 'Save view' : 'Add view'}
          </button>
        </form>
      </section>

      <button class="sb-reset" onClick={() => resetSidebar()}>
        <RotateCcw size={14} /> Reset sidebar to default
      </button>
    </div>
  );
}
