// Inline item editor (lives in the detail pane, never an overlay). Thin
// orchestrator: owns the common fields + the save flow, and wires the
// per-item-type field components (each owns its own signals and hands back a
// builder via `onReady`). The active type's builder is invoked on save to
// assemble the ItemInput. Keeps its default export + props identical so callers
// (Vault.tsx) need no changes.
import { createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { X } from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import type {
  CardInput,
  FieldInput,
  Folder,
  IdentityInput,
  ItemDetail,
  ItemInput,
  ItemType,
  LoginInput,
  SshKeyInput,
} from '../lib/types.ts';
import { linkedOptionsFor } from '../lib/itemFields.ts';
import { TYPE_LABELS } from '../lib/labels.ts';
import { toastError } from '../state/toast.ts';
import {
  CardFields,
  CommonToggles,
  CustomFieldsEditor,
  IdentityFields,
  LoginFields,
  NameAndFolder,
  NotesField,
  orNull,
  SshKeyFields,
} from './fields/index.ts';
import './ItemEditor.css';

export default function ItemEditor(props: {
  item?: ItemDetail | null;
  createType?: ItemType;
  /** Which connection this item belongs to / is created in. */
  accountEmail: string;
  folders: Folder[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const editing = createMemo(() => !!props.item);
  const itemType = createMemo<ItemType>(
    () => props.item?.itemType ?? props.createType ?? 'login',
  );
  // Linkable properties for this item type (empty for note / SSH key).
  const linkOptions = createMemo(() => linkedOptionsFor(itemType()));

  // ---- common fields ----
  const [name, setName] = createSignal(props.item?.name ?? '');
  const [folderId, setFolderId] = createSignal<string | null>(
    props.item?.folderId ?? null,
  );
  const [favorite, setFavorite] = createSignal(props.item?.favorite ?? false);
  const [reprompt, setReprompt] = createSignal(props.item?.reprompt ?? false);
  const [notes, setNotes] = createSignal(props.item?.notes ?? '');

  // ---- builders registered by each field component (only the active type's
  // component mounts, so only its builder is ever set). ----
  let buildLogin: (() => LoginInput) | null = null;
  let buildCard: (() => CardInput) | null = null;
  let buildIdentity: (() => IdentityInput) | null = null;
  let buildSshKey: (() => SshKeyInput) | null = null;
  let buildFields: (() => FieldInput[]) | null = null;

  const [saving, setSaving] = createSignal(false);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  }
  onMount(() => document.addEventListener('keydown', onKeyDown));
  onCleanup(() => document.removeEventListener('keydown', onKeyDown));

  async function save() {
    if (name().trim().length === 0) {
      toastError(new Error('Name is required.'));
      return;
    }
    const t = itemType();
    const input: ItemInput = {
      id: props.item?.id ?? null,
      itemType: t,
      name: name().trim(),
      folderId: folderId(),
      organizationId: props.item?.organizationId ?? null,
      favorite: favorite(),
      reprompt: reprompt(),
      notes: orNull(notes()),
      login: t === 'login' ? (buildLogin?.() ?? null) : null,
      card: t === 'card' ? (buildCard?.() ?? null) : null,
      identity: t === 'identity' ? (buildIdentity?.() ?? null) : null,
      sshKey: t === 'sshKey' ? (buildSshKey?.() ?? null) : null,
      fields: buildFields?.() ?? [],
    };

    setSaving(true);
    try {
      await ipc.saveItem(props.accountEmail, input);
      props.onSaved();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  }

  const heading = createMemo(
    () => `${editing() ? 'Edit' : 'New'} ${TYPE_LABELS[itemType()].toLowerCase()}`,
  );

  return (
    <div class="item-editor">
        <header class="ie-header">
          <h2 class="ie-title">{heading()}</h2>
          <button class="ghost icon-btn" title="Cancel" onClick={() => props.onClose()}>
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>

        <div class="ie-body">
          {/* ---- common ---- */}
          <NameAndFolder
            name={name()}
            setName={setName}
            folderId={folderId()}
            setFolderId={setFolderId}
            folders={props.folders}
            accountEmail={props.accountEmail}
          />

          {/* ---- login ---- */}
          <Show when={itemType() === 'login'}>
            <LoginFields item={props.item} onReady={(b) => (buildLogin = b)} />
          </Show>

          {/* ---- card ---- */}
          <Show when={itemType() === 'card'}>
            <CardFields item={props.item} onReady={(b) => (buildCard = b)} />
          </Show>

          {/* ---- identity ---- */}
          <Show when={itemType() === 'identity'}>
            <IdentityFields item={props.item} onReady={(b) => (buildIdentity = b)} />
          </Show>

          {/* ---- ssh key ---- */}
          <Show when={itemType() === 'sshKey'}>
            <SshKeyFields item={props.item} onReady={(b) => (buildSshKey = b)} />
          </Show>

          {/* ---- notes (all types) ---- */}
          <NotesField notes={notes()} setNotes={setNotes} />

          {/* ---- custom fields (all types) ---- */}
          <CustomFieldsEditor
            item={props.item}
            linkOptions={linkOptions()}
            onReady={(b) => (buildFields = b)}
          />

          {/* ---- toggles (all types) ---- */}
          <CommonToggles
            favorite={favorite()}
            setFavorite={setFavorite}
            reprompt={reprompt()}
            setReprompt={setReprompt}
          />
        </div>

        <footer class="ie-footer">
          <button class="ghost" onClick={() => props.onClose()}>
            Cancel
          </button>
          <button class="primary" disabled={saving()} onClick={() => void save()}>
            {saving() ? 'Saving…' : 'Save'}
          </button>
        </footer>
    </div>
  );
}
