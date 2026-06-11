// Common item fields shown for every item type: name + folder (top of the form)
// and the favorite / require-master-password toggles (bottom of the form). The
// orchestrator owns these signals because it needs them directly for the
// ItemInput payload and the name-required validation, so this component is
// presentational — it takes value getters + setters as props.
import { For } from 'solid-js';
import { Star } from 'lucide-solid';
import type { Folder } from '../../lib/types.ts';
import { t } from '../../lib/i18n.ts';

export function NameAndFolder(props: {
  name: string;
  setName: (v: string) => void;
  folderId: string | null;
  setFolderId: (v: string | null) => void;
  folders: Folder[];
  accountEmail: string;
}) {
  return (
    <div class="ie-section">
      <div class="field">
        <label>{t('common.name')}</label>
        <input
          value={props.name}
          onInput={(e) => props.setName(e.currentTarget.value)}
          placeholder={t('common.name')}
          autofocus
        />
      </div>

      <div class="field">
        <label>{t('fields.folder')}</label>
        <select
          value={props.folderId ?? ''}
          onChange={(e) =>
            props.setFolderId(e.currentTarget.value === '' ? null : e.currentTarget.value)
          }
        >
          <option value="">{t('fields.noFolder')}</option>
          <For each={props.folders.filter((f) => f.id !== null && f.accountEmail === props.accountEmail)}>
            {(f) => <option value={f.id ?? ''}>{f.name}</option>}
          </For>
        </select>
      </div>
    </div>
  );
}

export function NotesField(props: { notes: string; setNotes: (v: string) => void }) {
  return (
    <div class="ie-section">
      <div class="field">
        <label>{t('fields.notes')}</label>
        <textarea
          class="ie-textarea"
          value={props.notes}
          onInput={(e) => props.setNotes(e.currentTarget.value)}
          rows="4"
        />
      </div>
    </div>
  );
}

export function CommonToggles(props: {
  favorite: boolean;
  setFavorite: (v: boolean) => void;
  reprompt: boolean;
  setReprompt: (v: boolean) => void;
}) {
  return (
    <div class="ie-toggles">
      <button
        class="ghost ie-toggle"
        classList={{ active: props.favorite }}
        onClick={() => props.setFavorite(!props.favorite)}
      >
        <Star size={14} strokeWidth={1.75} class={props.favorite ? 'ie-star-on' : ''} />
        {t('fields.favorite')}
      </button>
      <label class="ie-check">
        <input
          type="checkbox"
          checked={props.reprompt}
          onChange={(e) => props.setReprompt(e.currentTarget.checked)}
        />
        {t('fields.requireMasterPassword')}
      </label>
    </div>
  );
}
