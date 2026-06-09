// Barrel for the per-item-type field editors plus the one form helper they all
// share. `orNull` maps a UI string to its nullable backend string (empty → null)
// — it lives here so every builder in this directory uses the same trimming
// without importing across each other.

export function orNull(s: string): string | null {
  const t = s.trim();
  return t.length > 0 ? t : null;
}

export { NameAndFolder, NotesField, CommonToggles } from './CommonFields.tsx';
export { default as LoginFields } from './LoginFields.tsx';
export { default as CardFields } from './CardFields.tsx';
export { default as IdentityFields } from './IdentityFields.tsx';
export { default as SshKeyFields } from './SshKeyFields.tsx';
export { default as CustomFieldsEditor } from './CustomFieldsEditor.tsx';
