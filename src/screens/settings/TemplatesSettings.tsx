// Settings › Templates — define reusable custom item templates. A template is an
// item type + optional default notes + a list of pre-defined custom fields; from
// the vault "Add" menu you can instantiate one to open the editor already filled
// in. Reads/writes the templates store (state/templates.ts). Templates live on
// this device (a UI preference), not in the vault — hidden fields are created
// empty and filled in per item, so no secret is ever stored here.

import { createSignal, For, Show } from 'solid-js';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from 'lucide-solid';
import type { ItemType } from '../../lib/types.ts';
import {
  TEMPLATE_ITEM_TYPES,
  type TemplateField,
  type TemplateFieldKind,
} from '../../lib/templates.ts';
import { addTemplate, removeTemplate, templateById, templates, updateTemplate } from '../../state/templates.ts';
import { typeIcon } from '../../lib/vaultIcons.ts';
import { createLabel } from '../../lib/vaultConfig.ts';
import { t } from '../../lib/i18n.ts';
import './TemplatesSettings.css';

// Reactive — called in render so a language flip re-localizes the field-kind labels.
function kindLabels(): Record<TemplateFieldKind, string> {
  return {
    text: t('templatesSettings.kindText'),
    hidden: t('templatesSettings.kindHidden'),
    boolean: t('templatesSettings.kindBoolean'),
  };
}

export default function TemplatesSettings() {
  // Form state. editId === null → creating a new template.
  const [editId, setEditId] = createSignal<string | null>(null);
  const [name, setName] = createSignal('');
  const [itemType, setItemType] = createSignal<ItemType>('login');
  const [notes, setNotes] = createSignal('');
  const [fields, setFields] = createSignal<TemplateField[]>([]);

  function resetForm() {
    setEditId(null);
    setName('');
    setItemType('login');
    setNotes('');
    setFields([]);
  }

  function beginEdit(id: string) {
    const tpl = templateById(id);
    if (!tpl) return;
    setEditId(id);
    setName(tpl.name);
    setItemType(tpl.itemType);
    setNotes(tpl.notes);
    setFields(tpl.fields.map((f) => ({ ...f })));
  }

  function submit(e: Event) {
    e.preventDefault();
    if (!name().trim()) return;
    const payload = { name: name(), itemType: itemType(), notes: notes(), fields: fields() };
    const id = editId();
    if (id) updateTemplate(id, payload);
    else addTemplate(payload);
    resetForm();
  }

  // ---- field-row editing ----
  function addField() {
    setFields((prev) => [...prev, { name: '', kind: 'text', value: '' }]);
  }
  function removeField(index: number) {
    setFields((prev) => prev.filter((_, i) => i !== index));
  }
  function updateField(index: number, patch: Partial<TemplateField>) {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }
  function moveField(index: number, dir: -1 | 1) {
    setFields((prev) => {
      const next = prev.slice();
      const j = index + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  }
  // Switching a row's kind: hidden fields carry no value; boolean seeds 'false'.
  function changeKind(index: number, kind: TemplateFieldKind, current: TemplateField) {
    const patch: Partial<TemplateField> = { kind };
    if (kind === 'hidden') patch.value = '';
    if (kind === 'boolean' && current.value !== 'true' && current.value !== 'false') {
      patch.value = 'false';
    }
    updateField(index, patch);
  }

  return (
    <div class="settings-page templates-settings">
      <section class="settings-section">
        <h3>{t('templatesSettings.title')}</h3>
        <p class="muted settings-help">{t('templatesSettings.help')}</p>

        <Show when={templates().length > 0}>
          <div class="tpl-list">
            <For each={templates()}>
              {(tpl) => {
                const Icon = typeIcon(tpl.itemType);
                return (
                  <div class="tpl-row">
                    <Icon size={15} strokeWidth={1.6} class="tpl-row-icon" />
                    <div class="tpl-row-text">
                      <span class="tpl-row-name">{tpl.name}</span>
                      <span class="tpl-row-sub muted">
                        {createLabel(tpl.itemType)} ·{' '}
                        {tpl.fields.length === 1
                          ? t('templatesSettings.fieldCountOne', { count: tpl.fields.length })
                          : t('templatesSettings.fieldCountMany', { count: tpl.fields.length })}
                      </span>
                    </div>
                    <button class="ghost icon-btn tpl-btn" title={t('common.edit')} onClick={() => beginEdit(tpl.id)}>
                      <Pencil size={14} />
                    </button>
                    <button
                      class="ghost icon-btn tpl-btn"
                      title={t('common.delete')}
                      onClick={() => {
                        if (editId() === tpl.id) resetForm();
                        removeTemplate(tpl.id);
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
      </section>

      <section class="settings-section">
        <form class="tpl-form" onSubmit={submit}>
          <div class="tpl-form-head">
            <h3>{editId() ? t('templatesSettings.editTemplate') : t('templatesSettings.newTemplate')}</h3>
            <Show when={editId()}>
              <button type="button" class="ghost icon-btn tpl-btn" title={t('templatesSettings.cancelEdit')} onClick={resetForm}>
                <X size={14} />
              </button>
            </Show>
          </div>

          <div class="field">
            <label>{t('common.name')}</label>
            <input
              value={name()}
              placeholder={t('templatesSettings.namePlaceholder')}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </div>

          <div class="field">
            <label>{t('templatesSettings.itemType')}</label>
            <select value={itemType()} onChange={(e) => setItemType(e.currentTarget.value as ItemType)}>
              <For each={TEMPLATE_ITEM_TYPES}>
                {(t) => <option value={t.type}>{t.label}</option>}
              </For>
            </select>
          </div>

          <div class="field">
            <label>{t('templatesSettings.defaultNotes')}</label>
            <textarea
              class="tpl-textarea"
              value={notes()}
              rows="2"
              onInput={(e) => setNotes(e.currentTarget.value)}
            />
          </div>

          <div class="tpl-fields-head">
            <label>{t('templatesSettings.customFields')}</label>
            <button type="button" class="ghost tpl-add-field" onClick={addField}>
              <Plus size={13} strokeWidth={1.75} /> {t('templatesSettings.addField')}
            </button>
          </div>
          <Show
            when={fields().length > 0}
            fallback={<p class="muted tpl-empty">{t('templatesSettings.noFieldsYet')}</p>}
          >
            <For each={fields()}>
              {(f, i) => (
                <div class="tpl-field-row">
                  <input
                    class="tpl-field-name"
                    value={f.name}
                    placeholder={t('templatesSettings.fieldNamePlaceholder')}
                    onInput={(e) => updateField(i(), { name: e.currentTarget.value })}
                  />
                  <Show
                    when={f.kind === 'boolean'}
                    fallback={
                      <input
                        class="tpl-field-val"
                        type="text"
                        value={f.kind === 'hidden' ? '' : f.value}
                        disabled={f.kind === 'hidden'}
                        placeholder={f.kind === 'hidden' ? t('templatesSettings.filledPerItem') : t('templatesSettings.defaultValuePlaceholder')}
                        onInput={(e) => updateField(i(), { value: e.currentTarget.value })}
                      />
                    }
                  >
                    <label class="tpl-check tpl-field-val">
                      <input
                        type="checkbox"
                        checked={f.value === 'true'}
                        onChange={(e) => updateField(i(), { value: e.currentTarget.checked ? 'true' : 'false' })}
                      />
                      {f.value === 'true' ? t('templatesSettings.true') : t('templatesSettings.false')}
                    </label>
                  </Show>
                  <select
                    class="tpl-field-kind"
                    value={f.kind}
                    onChange={(e) => changeKind(i(), e.currentTarget.value as TemplateFieldKind, f)}
                  >
                    <option value="text">{kindLabels().text}</option>
                    <option value="hidden">{kindLabels().hidden}</option>
                    <option value="boolean">{kindLabels().boolean}</option>
                  </select>
                  <button
                    type="button"
                    class="ghost icon-btn tpl-btn"
                    title={t('templatesSettings.moveUp')}
                    disabled={i() === 0}
                    onClick={() => moveField(i(), -1)}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    type="button"
                    class="ghost icon-btn tpl-btn"
                    title={t('templatesSettings.moveDown')}
                    disabled={i() === fields().length - 1}
                    onClick={() => moveField(i(), 1)}
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    type="button"
                    class="ghost icon-btn tpl-btn"
                    title={t('templatesSettings.removeField')}
                    onClick={() => removeField(i())}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </For>
          </Show>

          <button type="submit" class="primary tpl-submit" disabled={!name().trim()}>
            <Plus size={14} /> {editId() ? t('templatesSettings.saveTemplate') : t('templatesSettings.addTemplate')}
          </button>
        </form>
      </section>
    </div>
  );
}
