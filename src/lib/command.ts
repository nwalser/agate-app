// Shared command model + fuzzy ranking. Used by both the Ctrl-K command palette
// (components/CommandPalette.tsx) and the inline titlebar search dropdown
// (components/Titlebar.tsx), so the matching/highlighting behaves identically in
// both. Pure (no IPC, no DOM) — unit-tested in command.test.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IconComponent = any;

export interface Command {
  id: string;
  label: string;
  hint?: string;
  icon?: IconComponent;
  run: () => void;
}

/** Span of a label: matched spans are highlighted, plain spans are not. */
export interface LabelSpan {
  text: string;
  matched: boolean;
}

export interface FuzzyResult {
  /** Whether every query character appears in order. */
  hit: boolean;
  /** Higher is better. Rewards contiguous runs and early matches. */
  score: number;
  /** Indices in the label that the query matched. */
  indices: number[];
}

export interface RankedCommand {
  command: Command;
  spans: LabelSpan[];
}

/** Leading character that switches the search field into command mode. */
export const COMMAND_PREFIX = '/';

/** Whether a search-field value is a command (starts with `/`). */
export function isCommandQuery(value: string): boolean {
  return value.startsWith(COMMAND_PREFIX);
}

/** The command term — the value with its leading `/` stripped. */
export function commandTerm(value: string): string {
  return isCommandQuery(value) ? value.slice(COMMAND_PREFIX.length) : value;
}

/**
 * Case-insensitive subsequence matcher: every character of `query` must appear
 * in `label` in order. Contiguous runs score higher, and earlier matches beat
 * later ones, so tighter prefix-y matches rank first.
 */
export function fuzzyMatch(label: string, query: string): FuzzyResult {
  const q = query.trim().toLowerCase();
  if (q === '') return { hit: true, score: 0, indices: [] };

  const hay = label.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let run = 0;
  let qi = 0;

  for (let hi = 0; hi < hay.length && qi < q.length; hi++) {
    if (hay[hi] === q[qi]) {
      indices.push(hi);
      // Contiguous matches build a run bonus; gaps reset it.
      run = indices.length > 1 && indices[indices.length - 2] === hi - 1 ? run + 1 : 1;
      score += run * 4;
      // Early matches are slightly favored.
      if (hi < 8) score += 8 - hi;
      qi++;
    }
  }

  if (qi < q.length) return { hit: false, score: 0, indices: [] };
  return { hit: true, score, indices };
}

/** Build label spans from the set of matched character indices. */
export function spansFor(label: string, indices: number[]): LabelSpan[] {
  if (indices.length === 0) return [{ text: label, matched: false }];

  const matched = new Set(indices);
  const spans: LabelSpan[] = [];
  let buf = '';
  let bufMatched = matched.has(0);

  for (let i = 0; i < label.length; i++) {
    const isMatched = matched.has(i);
    if (isMatched !== bufMatched) {
      if (buf !== '') spans.push({ text: buf, matched: bufMatched });
      buf = '';
      bufMatched = isMatched;
    }
    buf += label[i];
  }
  if (buf !== '') spans.push({ text: buf, matched: bufMatched });
  return spans;
}

/**
 * Filter `commands` to those matching `query` (subsequence), best score first,
 * each carrying highlight spans. An empty query keeps the input order.
 */
export function rankCommands(commands: Command[], query: string): RankedCommand[] {
  const scored: { command: Command; score: number; indices: number[] }[] = [];
  for (const command of commands) {
    const res = fuzzyMatch(command.label, query);
    if (res.hit) scored.push({ command, score: res.score, indices: res.indices });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((r) => ({ command: r.command, spans: spansFor(r.command.label, r.indices) }));
}
