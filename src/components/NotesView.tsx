// Item-notes renderer: shows notes as lightweight, safe markdown with a toggle to
// the raw text. Rendering walks the typed AST from lib/markdown.ts and emits
// escaped SolidJS nodes (no innerHTML), so notes can never inject HTML/script.
// Links are pre-filtered to http(s)/mailto by the parser and opened through the
// Tauri opener (never in-app navigation).

import { For, Show, createSignal, type JSX } from 'solid-js';
import { Code2, Eye } from 'lucide-solid';
import { openUrl } from '@tauri-apps/plugin-opener';
import { parseMarkdown, type Block, type Inline } from '../lib/markdown.ts';
import './NotesView.css';

function renderInline(nodes: Inline[]): JSX.Element {
  return <For each={nodes}>{(n) => renderInlineNode(n)}</For>;
}

function renderInlineNode(n: Inline): JSX.Element {
  switch (n.t) {
    case 'text':
      return <>{n.v}</>;
    case 'bold':
      return <strong>{renderInline(n.c)}</strong>;
    case 'italic':
      return <em>{renderInline(n.c)}</em>;
    case 'code':
      return <code class="md-code">{n.v}</code>;
    case 'link':
      return (
        <a
          class="md-link"
          href={n.href}
          onClick={(e) => {
            e.preventDefault();
            void openUrl(n.href);
          }}
        >
          {renderInline(n.c)}
        </a>
      );
  }
}

function renderBlock(b: Block): JSX.Element {
  switch (b.t) {
    case 'p':
      return <p class="md-p">{renderInline(b.c)}</p>;
    case 'h':
      return (
        <div class="md-h" data-level={b.level}>
          {renderInline(b.c)}
        </div>
      );
    case 'ul':
      return (
        <ul class="md-ul">
          <For each={b.items}>{(it) => <li>{renderInline(it)}</li>}</For>
        </ul>
      );
    case 'ol':
      return (
        <ol class="md-ol">
          <For each={b.items}>{(it) => <li>{renderInline(it)}</li>}</For>
        </ol>
      );
    case 'code':
      return (
        <pre class="md-pre">
          <code>{b.v}</code>
        </pre>
      );
    case 'quote':
      return <blockquote class="md-quote">{renderInline(b.c)}</blockquote>;
  }
}

export default function NotesView(props: { notes: string }) {
  const [raw, setRaw] = createSignal(false);
  const blocks = () => parseMarkdown(props.notes);

  return (
    <div class="detail-field">
      <div class="md-head">
        <label>Notes</label>
        <button
          class="ghost icon-btn md-toggle"
          title={raw() ? 'Show rendered' : 'Show raw text'}
          onClick={() => setRaw((v) => !v)}
        >
          <Show when={raw()} fallback={<Code2 size={13} strokeWidth={1.75} />}>
            <Eye size={13} strokeWidth={1.75} />
          </Show>
        </button>
      </div>
      <Show when={!raw()} fallback={<pre class="detail-notes">{props.notes}</pre>}>
        <div class="md-body">
          <For each={blocks()}>{(b) => renderBlock(b)}</For>
        </div>
      </Show>
    </div>
  );
}
