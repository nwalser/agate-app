// Right-click row menu for the vault list: the actions available depend on the
// item (login-only copy/open entries, TOTP when present) and whether the list is
// the trash view (restore / delete-permanently vs. the normal favorite / edit /
// clone / trash set). Positioning is owned by the caller (clamped to the viewport
// in `openCtxMenu`); this just renders at the supplied x/y and closes on backdrop
// click or Escape. All handlers run against the single right-clicked item.

import { Show } from 'solid-js';
import {
  Copy,
  ExternalLink,
  KeyRound,
  Pencil,
  RotateCcw,
  Star,
  Timer,
  Trash2,
  UserRound,
} from 'lucide-solid';
import type { VaultItem } from '../lib/types.ts';

export interface CtxMenuTarget {
  item: VaultItem;
  x: number;
  y: number;
}

export default function VaultContextMenu(props: {
  menu: CtxMenuTarget;
  inTrash: boolean;
  onClose: () => void;
  copyUsername: (item: VaultItem) => void;
  copyPasswordFor: (item: VaultItem) => void;
  copyTotpFor: (item: VaultItem) => void;
  copyUriFor: (item: VaultItem) => void;
  openSiteFor: (item: VaultItem) => void;
  rowFavorite: (item: VaultItem) => void;
  rowEdit: (item: VaultItem) => void;
  detailClone: (id: string) => void;
  detailDelete: (id: string, permanent: boolean) => void;
  detailRestore: (id: string) => void;
}) {
  const item = () => props.menu.item;
  const isLogin = () => item().itemType === 'login';
  return (
    <>
      <div
        class="vault-menu-backdrop"
        onClick={() => props.onClose()}
        onContextMenu={(e) => {
          e.preventDefault();
          props.onClose();
        }}
      />
      <div class="vault-ctx" role="menu" style={{ left: props.menu.x + 'px', top: props.menu.y + 'px' }}>
        <div class="vault-ctx-title">{item().name}</div>
        <div class="vault-ctx-sep" />
        <Show when={item().username}>
          <button
            class="vault-ctx-item"
            onClick={() => {
              props.onClose();
              props.copyUsername(item());
            }}
          >
            <UserRound size={14} /> Copy username
          </button>
        </Show>
        <Show when={isLogin()}>
          <button
            class="vault-ctx-item"
            onClick={() => {
              props.onClose();
              props.copyPasswordFor(item());
            }}
          >
            <KeyRound size={14} /> Copy password
          </button>
        </Show>
        <Show when={item().hasTotp}>
          <button
            class="vault-ctx-item"
            onClick={() => {
              props.onClose();
              props.copyTotpFor(item());
            }}
          >
            <Timer size={14} /> Copy one-time code
          </button>
        </Show>
        <Show when={isLogin()}>
          <button
            class="vault-ctx-item"
            onClick={() => {
              props.onClose();
              props.copyUriFor(item());
            }}
          >
            <Copy size={14} /> Copy website
          </button>
          <button
            class="vault-ctx-item"
            onClick={() => {
              props.onClose();
              props.openSiteFor(item());
            }}
          >
            <ExternalLink size={14} /> Open website
          </button>
        </Show>
        <div class="vault-ctx-sep" />
        <Show
          when={!props.inTrash}
          fallback={
            <>
              <button
                class="vault-ctx-item"
                onClick={() => {
                  props.onClose();
                  props.detailRestore(item().id);
                }}
              >
                <RotateCcw size={14} /> Restore
              </button>
              <button
                class="vault-ctx-item danger"
                onClick={() => {
                  props.onClose();
                  props.detailDelete(item().id, true);
                }}
              >
                <Trash2 size={14} /> Delete permanently
              </button>
            </>
          }
        >
          <button
            class="vault-ctx-item"
            onClick={() => {
              props.onClose();
              props.rowFavorite(item());
            }}
          >
            <Star size={14} /> {item().favorite ? 'Unfavorite' : 'Favorite'}
          </button>
          <button
            class="vault-ctx-item"
            onClick={() => {
              props.onClose();
              props.rowEdit(item());
            }}
          >
            <Pencil size={14} /> Edit
          </button>
          <button
            class="vault-ctx-item"
            onClick={() => {
              props.onClose();
              props.detailClone(item().id);
            }}
          >
            <Copy size={14} /> Clone
          </button>
          <div class="vault-ctx-sep" />
          <button
            class="vault-ctx-item danger"
            onClick={() => {
              props.onClose();
              props.detailDelete(item().id, false);
            }}
          >
            <Trash2 size={14} /> Move to trash
          </button>
        </Show>
      </div>
    </>
  );
}
