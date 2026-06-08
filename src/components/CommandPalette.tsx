import { createMemo, createSignal, For, Show } from 'solid-js';
import './CommandPalette.css';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon?: any;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}

/** Span of the label: matched spans are highlighted, plain spans are not. */
interface LabelSpan {
  text: string;
  matched: boolean;
}

interface FuzzyResult {
  /** Whether every query character appears in order. */
  hit: boolean;
  /** Higher is better. Rewards contiguous runs and early matches. */
  score: number;
  /** Indices in the label that the query matched. */
  indices: number[];
}

/**
 * Case-insensitive subsequence matcher: every character of `query` must appear
 * in `label` in order. Contiguous runs score higher, and earlier matches beat
 * later ones, so tighter prefix-y matches rank first.
 */
function fuzzyMatch(label: string, query: string): FuzzyResult {
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
function spansFor(label: string, indices: number[]): LabelSpan[] {
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

interface RankedCommand {
  command: Command;
  spans: LabelSpan[];
}

export default function CommandPalette(props: CommandPaletteProps) {
  const [query, setQuery] = createSignal('');
  const [selected, setSelected] = createSignal(0);

  const ranked = createMemo<RankedCommand[]>(() => {
    const q = query();
    const out: { command: Command; score: number; indices: number[] }[] = [];
    for (const command of props.commands) {
      const res = fuzzyMatch(command.label, q);
      if (res.hit) out.push({ command, score: res.score, indices: res.indices });
    }
    out.sort((a, b) => b.score - a.score);
    return out.map((r) => ({ command: r.command, spans: spansFor(r.command.label, r.indices) }));
  });

  // Keep the selected index within the (re-filtered) result bounds.
  const clampedSelected = createMemo(() => {
    const count = ranked().length;
    if (count === 0) return 0;
    return Math.min(selected(), count - 1);
  });

  function reset() {
    setQuery('');
    setSelected(0);
  }

  function runAt(index: number) {
    const list = ranked();
    const target = list[index];
    if (!target) return;
    props.onClose();
    reset();
    target.command.run();
  }

  function onKeyDown(event: KeyboardEvent) {
    const count = ranked().length;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (count > 0) setSelected((s) => (Math.min(s, count - 1) + 1) % count);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (count > 0) setSelected((s) => (Math.min(s, count - 1) - 1 + count) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runAt(clampedSelected());
    } else if (event.key === 'Escape') {
      event.preventDefault();
      props.onClose();
      reset();
    }
  }

  // Autofocus when the overlay mounts; SolidJS ref runs after insertion.
  function focusInput(el: HTMLInputElement) {
    queueMicrotask(() => el.focus());
  }

  function onOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      props.onClose();
      reset();
    }
  }

  return (
    <Show when={props.open}>
      <div class="cmdp-overlay" onClick={onOverlayClick}>
        <div class="cmdp-panel" role="dialog" aria-label="Command palette" onKeyDown={onKeyDown}>
          <input
            ref={focusInput}
            class="cmdp-input"
            type="text"
            placeholder="Type a command…"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setSelected(0);
            }}
            aria-label="Search commands"
          />
          <Show
            when={ranked().length > 0}
            fallback={<div class="cmdp-empty">No matching commands</div>}
          >
            <ul class="cmdp-list" role="listbox">
              <For each={ranked()}>
                {(entry, index) => {
                  const Icon = entry.command.icon;
                  const isSelected = () => index() === clampedSelected();
                  return (
                    <li
                      class="cmdp-item"
                      classList={{ 'cmdp-item-selected': isSelected() }}
                      role="option"
                      aria-selected={isSelected()}
                      onMouseEnter={() => setSelected(index())}
                      onClick={() => runAt(index())}
                    >
                      <Show when={Icon}>
                        <span class="cmdp-icon">
                          <Icon size={15} strokeWidth={1.5} />
                        </span>
                      </Show>
                      <span class="cmdp-label">
                        <For each={entry.spans}>
                          {(span) => (
                            <Show when={span.matched} fallback={<>{span.text}</>}>
                              <mark class="cmdp-mark">{span.text}</mark>
                            </Show>
                          )}
                        </For>
                      </span>
                      <Show when={entry.command.hint}>
                        <span class="cmdp-hint">{entry.command.hint}</span>
                      </Show>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </div>
      </div>
    </Show>
  );
}
