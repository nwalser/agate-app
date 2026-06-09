import { afterEach, describe, expect, it } from 'vitest';
import {
  TEMPLATES_STORAGE_KEY,
  parseTemplate,
  readTemplates,
  templateToSeed,
  type ItemTemplate,
} from './templates.ts';

const tpl = (over: Partial<ItemTemplate> = {}): ItemTemplate => ({
  id: 'tpl:abc',
  name: 'Server creds',
  itemType: 'login',
  notes: '',
  fields: [],
  ...over,
});

afterEach(() => localStorage.clear());

describe('parseTemplate', () => {
  it('round-trips a well-formed template', () => {
    const t = tpl({ fields: [{ name: 'Host', kind: 'text', value: 'example.com' }] });
    expect(parseTemplate(t)).toEqual(t);
  });

  it('rejects a bad id, empty name, bad item type, and non-objects', () => {
    expect(parseTemplate({ ...tpl(), id: 'abc' })).toBeNull();
    expect(parseTemplate({ ...tpl(), name: '   ' })).toBeNull();
    expect(parseTemplate({ ...tpl(), itemType: 'nope' })).toBeNull();
    expect(parseTemplate(null)).toBeNull();
    expect(parseTemplate('tpl:x')).toBeNull();
  });

  it('coerces an unknown field kind to text', () => {
    const out = parseTemplate({ ...tpl(), fields: [{ name: 'F', kind: 'weird', value: 'v' }] });
    expect(out?.fields[0]).toEqual({ name: 'F', kind: 'text', value: 'v' });
  });

  it('never keeps a stored value on a hidden field', () => {
    const out = parseTemplate({ ...tpl(), fields: [{ name: 'Secret', kind: 'hidden', value: 'leak' }] });
    expect(out?.fields[0]).toEqual({ name: 'Secret', kind: 'hidden', value: '' });
  });
});

describe('readTemplates', () => {
  it('returns an empty list when nothing is stored', () => {
    expect(readTemplates()).toEqual([]);
  });

  it('falls back to an empty list on corrupt JSON', () => {
    localStorage.setItem(TEMPLATES_STORAGE_KEY, '{not json');
    expect(readTemplates()).toEqual([]);
  });

  it('drops invalid entries but keeps the valid ones', () => {
    const good = tpl({ id: 'tpl:keep' });
    localStorage.setItem(
      TEMPLATES_STORAGE_KEY,
      JSON.stringify([good, { id: 'bad', name: 'x', itemType: 'login' }]),
    );
    expect(readTemplates()).toEqual([good]);
  });
});

describe('templateToSeed', () => {
  it('carries the item type, notes, and custom fields into a create seed (no id)', () => {
    const seed = templateToSeed(
      tpl({
        itemType: 'card',
        notes: 'fill me',
        fields: [
          { name: 'PIN', kind: 'hidden', value: '' },
          { name: 'Bank', kind: 'text', value: 'Acme' },
          { name: 'Active', kind: 'boolean', value: 'true' },
        ],
      }),
    );
    expect(seed.id).toBe(''); // no id → saving creates a new item
    expect(seed.name).toBe(''); // user names the item
    expect(seed.itemType).toBe('card');
    expect(seed.notes).toBe('fill me');
    expect(seed.fields).toEqual([
      { name: 'PIN', value: '', fieldType: 'hidden', linkedId: null },
      { name: 'Bank', value: 'Acme', fieldType: 'text', linkedId: null },
      { name: 'Active', value: 'true', fieldType: 'boolean', linkedId: null },
    ]);
  });

  it('maps empty notes to null and drops unnamed fields', () => {
    const seed = templateToSeed(tpl({ notes: '   ', fields: [{ name: '  ', kind: 'text', value: 'x' }] }));
    expect(seed.notes).toBeNull();
    expect(seed.fields).toEqual([]);
  });
});
