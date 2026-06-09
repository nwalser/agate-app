// Live custom-item-template store — the stateful half (mirrors state/sidebar.ts).
// Holds the reactive `templates` signal (seeded from localStorage) plus the CRUD
// mutators, each writing through to localStorage best-effort. The immutable schema
// / parse lives in lib/templates.ts. Not secret: structure + non-secret defaults,
// a UI preference rather than keychain material (hidden fields store no value).

import { createSignal } from 'solid-js';
import type { ItemType } from '../lib/types.ts';
import {
  TEMPLATES_STORAGE_KEY,
  readTemplates,
  type ItemTemplate,
  type TemplateField,
} from '../lib/templates.ts';

const [templates, setTemplatesSignal] = createSignal<ItemTemplate[]>(readTemplates());

function persist(next: ItemTemplate[]) {
  setTemplatesSignal(next);
  try {
    localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}

export { templates };

/** Find a template by id (null if unknown). */
export function templateById(id: string): ItemTemplate | null {
  return templates().find((t) => t.id === id) ?? null;
}

/** Normalise fields at the trust boundary: drop unnamed rows, blank hidden values. */
function cleanFields(fields: TemplateField[]): TemplateField[] {
  return fields
    .filter((f) => f.name.trim().length > 0)
    .map((f) => ({
      name: f.name.trim(),
      kind: f.kind,
      value: f.kind === 'hidden' ? '' : f.value,
    }));
}

/** Create a template (appended). Returns the new id, or null if the name is blank. */
export function addTemplate(input: {
  name: string;
  itemType: ItemType;
  notes: string;
  fields: TemplateField[];
}): string | null {
  const name = input.name.trim();
  if (!name) return null;
  const id = `tpl:${crypto.randomUUID()}`;
  const tpl: ItemTemplate = {
    id,
    name,
    itemType: input.itemType,
    notes: input.notes.trim(),
    fields: cleanFields(input.fields),
  };
  persist([...templates(), tpl]);
  return id;
}

/** Patch an existing template in place (blank name ignored). */
export function updateTemplate(
  id: string,
  patch: Partial<Omit<ItemTemplate, 'id'>>,
): void {
  persist(
    templates().map((t) => {
      if (t.id !== id) return t;
      const name = patch.name === undefined ? t.name : patch.name.trim() || t.name;
      const fields = patch.fields === undefined ? t.fields : cleanFields(patch.fields);
      const notes = patch.notes === undefined ? t.notes : patch.notes.trim();
      return { ...t, ...patch, id: t.id, name, notes, fields };
    }),
  );
}

/** Delete a template. */
export function removeTemplate(id: string): void {
  persist(templates().filter((t) => t.id !== id));
}
