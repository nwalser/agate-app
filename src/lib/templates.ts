// Custom item templates — the immutable, pure half (mirrors columnConfig /
// sidebarConfig). A template is a reusable item skeleton: an item type, optional
// default notes, and a list of pre-defined custom fields. Instantiating one opens
// the item editor pre-filled with those fields, so recurring item shapes (server
// creds, software licences, Wi-Fi, …) don't have to be rebuilt by hand each time.
//
// Templates are a local UI preference (localStorage), NOT vault data: they hold
// structure + non-secret defaults only. Hidden fields therefore carry NO stored
// value — they're seeded empty and filled in per item, so a real secret is never
// written to plaintext localStorage (see `templateToSeed`).

import type { CustomField, ItemDetail, ItemType } from './types.ts';
import { t } from './i18n.ts';

/** Field kinds a template can pre-define. A subset of the editor's custom-field
 *  kinds — no `linked` (its targets are item-type specific and item-instance
 *  bound, which doesn't generalise to a template). */
export type TemplateFieldKind = 'text' | 'hidden' | 'boolean';

export const TEMPLATE_FIELD_KINDS: TemplateFieldKind[] = ['text', 'hidden', 'boolean'];

export interface TemplateField {
  name: string;
  kind: TemplateFieldKind;
  /** Default value seeded into the new item. Always '' for `hidden` (never persist
   *  a secret); 'true' | 'false' for `boolean`; free text for `text`. */
  value: string;
}

export interface ItemTemplate {
  /** Always `tpl:<uuid>`. */
  id: string;
  name: string;
  itemType: ItemType;
  /** Default notes seeded into the new item (empty = none). */
  notes: string;
  fields: TemplateField[];
}

export const TEMPLATES_STORAGE_KEY = 'agate.templates';

/** Item types a template can target (excludes `unknown`). `label` is a getter so
 *  it tracks the active locale when read in JSX. */
export const TEMPLATE_ITEM_TYPES: { type: ItemType; label: string }[] = [
  { type: 'login', get label() { return t('itemType.login'); } },
  { type: 'card', get label() { return t('itemType.card'); } },
  { type: 'identity', get label() { return t('itemType.identity'); } },
  { type: 'secureNote', get label() { return t('itemType.secureNote'); } },
  { type: 'sshKey', get label() { return t('itemType.sshKey'); } },
];

const VALID_TYPES = new Set<ItemType>(TEMPLATE_ITEM_TYPES.map((t) => t.type));

export function isTemplateId(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('tpl:');
}

function isTemplateFieldKind(v: unknown): v is TemplateFieldKind {
  return v === 'text' || v === 'hidden' || v === 'boolean';
}

function parseField(v: unknown): TemplateField | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string') return null;
  const kind = isTemplateFieldKind(o.kind) ? o.kind : 'text';
  // Hidden fields never carry a stored value (no secrets in localStorage).
  const value = kind === 'hidden' ? '' : typeof o.value === 'string' ? o.value : '';
  return { name: o.name, kind, value };
}

/** Validate an arbitrary value into an `ItemTemplate`, or null if unusable. */
export function parseTemplate(v: unknown): ItemTemplate | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isTemplateId(o.id)) return null;
  if (typeof o.name !== 'string' || o.name.trim() === '') return null;
  if (typeof o.itemType !== 'string' || !VALID_TYPES.has(o.itemType as ItemType)) return null;
  const notes = typeof o.notes === 'string' ? o.notes : '';
  const fields = Array.isArray(o.fields)
    ? o.fields.map(parseField).filter((f): f is TemplateField => f !== null)
    : [];
  return { id: o.id, name: o.name, itemType: o.itemType as ItemType, notes, fields };
}

/** Read + validate the persisted templates; corrupt/unavailable → empty list. */
export function readTemplates(): ItemTemplate[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseTemplate).filter((t): t is ItemTemplate => t !== null);
  } catch {
    // ignore: corrupt/unavailable templates fall back to an empty list
    return [];
  }
}

/**
 * Build a synthetic `ItemDetail` that pre-fills the item editor from a template.
 * It is never persisted as-is: the editor treats a seed as a *create* (no id), so
 * saving produces a brand-new item. Type-specific blocks are left empty (the field
 * components fall back to blank); only the custom fields + notes carry over. Hidden
 * fields are seeded empty so no secret is ever sourced from localStorage.
 */
export function templateToSeed(tpl: ItemTemplate): ItemDetail {
  const fields: CustomField[] = tpl.fields
    .filter((f) => f.name.trim().length > 0)
    .map((f) => ({
      name: f.name,
      value: f.kind === 'hidden' ? '' : f.value,
      fieldType: f.kind,
      linkedId: null,
    }));
  return {
    id: '',
    accountEmail: '',
    accountLabel: '',
    name: '',
    itemType: tpl.itemType,
    favorite: false,
    reprompt: false,
    notes: tpl.notes.trim().length > 0 ? tpl.notes : null,
    login: null,
    card: null,
    identity: null,
    sshKey: null,
    fields,
    folderId: null,
    organizationId: null,
    revisionDate: '',
    creationDate: '',
    collectionIds: [],
    attachments: [],
    passkeys: [],
  };
}
