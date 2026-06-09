import { createMemo, createSignal, For, Show } from 'solid-js';
import { type Command, rankCommands } from '../lib/command.ts';
import './CommandPalette.css';

export type { Command };

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}

export default function CommandPalette(props: CommandPaletteProps) {
  const [query, setQuery] = createSignal('');
  const [selected, setSelected] = createSignal(0);

  const ranked = createMemo(() => rankCommands(props.commands, query()));

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
