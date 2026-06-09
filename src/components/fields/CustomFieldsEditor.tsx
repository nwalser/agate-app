// Custom-field editor (shown for every item type): add/remove/edit text, hidden,
// boolean, and linked field rows. A linked row picks a target property of the
// item by numeric LinkedIdType (the options depend on the item type). Owns its
// own `fields` signal and exposes its FieldInput[] builder via `onReady`.
import { createSignal, For, Match, Show, Switch } from 'solid-js';
import { Link as LinkIcon, Plus, Trash2 } from 'lucide-solid';
import type { FieldInput, ItemDetail } from '../../lib/types.ts';
import { FIELD_KIND_TO_INT, fieldStringToLabel, type FieldKindLabel } from '../../lib/fieldKinds.ts';
import type { LinkedOption } from '../../lib/itemFields.ts';
import { orNull } from './index.ts';

interface FieldRow {
  name: string;
  value: string;
  kind: FieldKindLabel;
  /** For Linked rows: the numeric LinkedIdType target. */
  linkedId: number | null;
}

export default function CustomFieldsEditor(props: {
  item?: ItemDetail | null;
  /** Linkable properties for this item type (empty for note / SSH key). */
  linkOptions: LinkedOption[];
  onReady: (build: () => FieldInput[]) => void;
}) {
  const [fields, setFields] = createSignal<FieldRow[]>(
    (props.item?.fields ?? []).map((f) => ({
      name: f.name ?? '',
      value: f.value ?? '',
      kind: fieldStringToLabel(f.fieldType),
      linkedId: f.linkedId ?? null,
    })),
  );

  function addField() {
    setFields((prev) => [...prev, { name: '', value: '', kind: 'Text', linkedId: null }]);
  }
  function removeField(index: number) {
    setFields((prev) => prev.filter((_, i) => i !== index));
  }
  function updateField(index: number, patch: Partial<FieldRow>) {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }
  // Switching a row's kind: seed a default linked target / boolean value so the
  // row is immediately valid.
  function changeFieldKind(index: number, kind: FieldKindLabel, current: FieldRow) {
    const patch: Partial<FieldRow> = { kind };
    if (kind === 'Linked' && current.linkedId == null) {
      patch.linkedId = props.linkOptions[0]?.id ?? null;
    }
    if (kind === 'Boolean' && current.value !== 'true' && current.value !== 'false') {
      patch.value = 'false';
    }
    updateField(index, patch);
  }

  // A linked row carries no value (the target id is the payload); other rows
  // carry no linkedId. Drop rows that are entirely empty / incomplete.
  function buildFields(): FieldInput[] {
    return fields()
      .filter((f) =>
        f.kind === 'Linked'
          ? f.name.trim().length > 0 && f.linkedId != null
          : f.name.trim().length > 0 || f.value.trim().length > 0,
      )
      .map((f) => ({
        name: orNull(f.name),
        value: f.kind === 'Linked' ? null : orNull(f.value),
        fieldType: FIELD_KIND_TO_INT[f.kind],
        linkedId: f.kind === 'Linked' ? f.linkedId : null,
      }));
  }
  props.onReady(buildFields);

  return (
    <div class="ie-section">
      <div class="ie-section-head">
        <label>Custom fields</label>
        <button class="ghost ie-add" onClick={addField}>
          <Plus size={13} strokeWidth={1.75} /> Add field
        </button>
      </div>
      <Show when={fields().length === 0}>
        <p class="ie-empty-hint">No custom fields. Add text, hidden, boolean, or linked fields.</p>
      </Show>
      <For each={fields()}>
        {(f, i) => (
          <div class="ie-field-row">
            <input
              class="ie-field-name"
              value={f.name}
              placeholder="Field name"
              onInput={(e) => updateField(i(), { name: e.currentTarget.value })}
            />
            <Switch>
              <Match when={f.kind === 'Boolean'}>
                <label class="ie-check ie-field-val">
                  <input
                    type="checkbox"
                    checked={f.value === 'true'}
                    onChange={(e) =>
                      updateField(i(), {
                        value: e.currentTarget.checked ? 'true' : 'false',
                      })
                    }
                  />
                  {f.value === 'true' ? 'True' : 'False'}
                </label>
              </Match>
              <Match when={f.kind === 'Linked'}>
                <div class="ie-field-val ie-linked-val">
                  <LinkIcon size={13} strokeWidth={1.75} class="ie-linked-icon" />
                  <select
                    class="ie-grow"
                    value={f.linkedId ?? ''}
                    onChange={(e) =>
                      updateField(i(), { linkedId: Number(e.currentTarget.value) })
                    }
                  >
                    <For each={props.linkOptions}>
                      {(opt) => <option value={opt.id}>{opt.label}</option>}
                    </For>
                  </select>
                </div>
              </Match>
              <Match when={true}>
                <input
                  class="ie-field-val"
                  type={f.kind === 'Hidden' ? 'password' : 'text'}
                  value={f.value}
                  placeholder="Value"
                  autocomplete="off"
                  onInput={(e) => updateField(i(), { value: e.currentTarget.value })}
                />
              </Match>
            </Switch>
            <select
              class="ie-fieldkind"
              value={f.kind}
              onChange={(e) =>
                changeFieldKind(i(), e.currentTarget.value as FieldKindLabel, f)
              }
            >
              <option value="Text">Text</option>
              <option value="Hidden">Hidden</option>
              <option value="Boolean">Boolean</option>
              <Show when={props.linkOptions.length > 0}>
                <option value="Linked">Linked</option>
              </Show>
            </select>
            <button
              class="ghost icon-btn"
              title="Remove"
              onClick={() => removeField(i())}
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
