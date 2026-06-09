// Settings › Sidebar — customize the left nav rail: reorder entries (drag or
// arrows), show/hide any entry, and manage saved custom queries (a name + search
// text + base filter pinned to the rail). Reads/writes the sidebar store
// (state/sidebar.ts); the rail re-renders live. Settings stays bottom-pinned and
// is not listed here.

import { createSignal, For, Show } from 'solid-js';
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, Minus, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-solid';
import type { IconComponent } from '../../lib/icon.ts';
import type { ItemType } from '../../lib/types.ts';
import { TYPE_FILTERS } from '../../lib/vaultConfig.ts';
import {
  QUERY_ICON,
  entryMeta,
  isBuiltinId,
  isDividerId,
  type SavedFilter,
} from '../../lib/sidebarConfig.ts';
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

type FilterKind = SavedFilter['kind'];

function resolveRow(id: string): { label: string; icon: IconComponent } {
  if (isBuiltinId(id)) return entryMeta(id);
  if (isDividerId(id)) return { label: 'Divider', icon: Minus };
  const q = queryById(id);
  return { label: q?.name ?? id, icon: QUERY_ICON };
}

function filterLabel(f: SavedFilter): string {
  if (f.kind === 'type') return TYPE_FILTERS.find((t) => t.type === f.itemType)?.label ?? f.itemType;
  if (f.kind === 'favorites') return 'Favorites';
  if (f.kind === 'trash') return 'Trash';
  return 'All items';
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

  // Saved-query add/edit form state. editId === null → adding a new query.
  const [editId, setEditId] = createSignal<string | null>(null);
  const [name, setName] = createSignal('');
  const [text, setText] = createSignal('');
  const [kind, setKind] = createSignal<FilterKind>('all');
  const [itemType, setItemType] = createSignal<ItemType>('login');

  function buildFilter(): SavedFilter {
    const k = kind();
    return k === 'type' ? { kind: 'type', itemType: itemType() } : { kind: k };
  }

  function resetForm() {
    setEditId(null);
    setName('');
    setText('');
    setKind('all');
    setItemType('login');
  }

  function beginEdit(id: string) {
    const q = queryById(id);
    if (!q) return;
    setEditId(id);
    setName(q.name);
    setText(q.query);
    setKind(q.filter.kind);
    if (q.filter.kind === 'type') setItemType(q.filter.itemType);
  }

  function submit(e: Event) {
    e.preventDefault();
    if (!name().trim()) return;
    const id = editId();
    if (id) updateQuery(id, { name: name(), query: text(), filter: buildFilter() });
    else addQuery({ name: name(), query: text(), filter: buildFilter() });
    resetForm();
  }

  const customQueries = () => sidebar().queries;

  const KINDS: { value: FilterKind; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'favorites', label: 'Favorites' },
    { value: 'trash', label: 'Trash' },
    { value: 'type', label: 'Type' },
  ];

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
        <h3>Custom queries</h3>
        <p class="muted settings-help">
          Pin a saved search to the rail. Clicking it scopes the list to the base filter and fills
          the search box with your text.
        </p>

        <Show when={customQueries().length > 0}>
          <div class="sb-queries">
            <For each={customQueries()}>
              {(q) => (
                <div class="sb-query">
                  <QUERY_ICON size={15} strokeWidth={1.6} class="sb-row-icon" />
                  <div class="sb-query-text">
                    <span class="sb-query-name">{q.name}</span>
                    <span class="sb-query-sub muted">
                      {filterLabel(q.filter)}
                      <Show when={q.query.trim()}> · “{q.query}”</Show>
                    </span>
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
              )}
            </For>
          </div>
        </Show>

        <form class="sb-form" onSubmit={submit}>
          <div class="sb-form-head">
            <span class="sb-form-title">{editId() ? 'Edit query' : 'New query'}</span>
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
          <input
            class="sb-input"
            placeholder="Search text (optional)"
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
          />
          <div class="sb-seg" role="group" aria-label="Base filter">
            <For each={KINDS}>
              {(k) => (
                <button
                  type="button"
                  class="sb-seg-btn"
                  classList={{ active: kind() === k.value }}
                  aria-pressed={kind() === k.value}
                  onClick={() => setKind(k.value)}
                >
                  {k.label}
                </button>
              )}
            </For>
          </div>
          <Show when={kind() === 'type'}>
            <select class="sb-input" value={itemType()} onChange={(e) => setItemType(e.currentTarget.value as ItemType)}>
              <For each={TYPE_FILTERS}>{(t) => <option value={t.type}>{t.label}</option>}</For>
            </select>
          </Show>
          <button type="submit" class="sb-add" disabled={!name().trim()}>
            <Plus size={14} /> {editId() ? 'Save query' : 'Add query'}
          </button>
        </form>
      </section>

      <button class="sb-reset" onClick={() => resetSidebar()}>
        <RotateCcw size={14} /> Reset sidebar to default
      </button>
    </div>
  );
}
