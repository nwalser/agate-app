// Vault search query. Lifted out of the Vault screen so the custom window
// titlebar (components/Titlebar.tsx) can host the search field while the Vault
// list reads the same query. Not a secret — never persisted, in-memory only.

import { createSignal } from 'solid-js';

const [query, setQuery] = createSignal('');

export { query, setQuery };
