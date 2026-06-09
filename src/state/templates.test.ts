import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each case loads a fresh copy of the store so the module-level signal + the
// localStorage read at import happen against a clean, seeded state.
async function freshTemplates() {
  vi.resetModules();
  localStorage.clear();
  return import('./templates.ts');
}

beforeEach(() => localStorage.clear());

describe('templates store', () => {
  it('starts empty and persists an added template', async () => {
    const m = await freshTemplates();
    expect(m.templates()).toEqual([]);
    const id = m.addTemplate({ name: 'Wi-Fi', itemType: 'secureNote', notes: '', fields: [] });
    expect(id).not.toBeNull();
    expect(m.templates()).toHaveLength(1);
    expect(m.templates()[0]).toMatchObject({ name: 'Wi-Fi', itemType: 'secureNote' });
    // Persisted, not just in-memory.
    expect(JSON.parse(localStorage.getItem('agate.templates') ?? '[]')).toHaveLength(1);
  });

  it('refuses a blank name', async () => {
    const m = await freshTemplates();
    expect(m.addTemplate({ name: '   ', itemType: 'login', notes: '', fields: [] })).toBeNull();
    expect(m.templates()).toEqual([]);
  });

  it('drops unnamed rows and blanks hidden values on save', async () => {
    const m = await freshTemplates();
    const id = m.addTemplate({
      name: 'Server',
      itemType: 'login',
      notes: '',
      fields: [
        { name: 'Host', kind: 'text', value: 'h' },
        { name: '  ', kind: 'text', value: 'dropme' },
        { name: 'Secret', kind: 'hidden', value: 'leak' },
      ],
    });
    const tpl = m.templateById(id ?? '');
    expect(tpl?.fields).toEqual([
      { name: 'Host', kind: 'text', value: 'h' },
      { name: 'Secret', kind: 'hidden', value: '' },
    ]);
  });

  it('updates and removes a template', async () => {
    const m = await freshTemplates();
    const id = m.addTemplate({ name: 'A', itemType: 'login', notes: '', fields: [] }) ?? '';
    m.updateTemplate(id, { name: 'B', notes: 'note' });
    expect(m.templateById(id)).toMatchObject({ name: 'B', notes: 'note' });
    // A blank name patch is ignored (keeps the previous name).
    m.updateTemplate(id, { name: '   ' });
    expect(m.templateById(id)?.name).toBe('B');
    m.removeTemplate(id);
    expect(m.templates()).toEqual([]);
  });
});
