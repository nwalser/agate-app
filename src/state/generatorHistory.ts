// Recently generated secrets (password generator history). Held IN MEMORY ONLY —
// generated passwords are secrets, so per CLAUDE.md they never touch localStorage
// or any plaintext file. The list lives for the session and is wiped on lock
// (App.lock → clearGeneratorHistory), mirroring how the decrypted vault is
// treated. This is a convenience buffer ("what did I just generate?"), not
// durable storage.

import { createSignal } from 'solid-js';

export interface GeneratorEntry {
  value: string;
  /** Epoch ms the value was generated (for the relative-time label). */
  at: number;
}

// Cap the buffer — a generator session rarely needs more than the last handful.
const MAX_ENTRIES = 20;

const [generatorHistory, setHistory] = createSignal<GeneratorEntry[]>([]);
export { generatorHistory };

/** Record a freshly generated secret, most-recent first, de-duplicated. */
export function pushGeneratorHistory(value: string): void {
  if (!value) return;
  setHistory((prev) => {
    const deduped = prev.filter((e) => e.value !== value);
    return [{ value, at: Date.now() }, ...deduped].slice(0, MAX_ENTRIES);
  });
}

/** Wipe the buffer — called on lock so secrets don't linger after the vault closes. */
export function clearGeneratorHistory(): void {
  setHistory([]);
}
