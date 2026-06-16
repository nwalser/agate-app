// Tiny, safe markdown parser for item notes. Produces a typed block/inline AST —
// NEVER an HTML string — so the renderer (components/NotesView.tsx) can emit
// escaped SolidJS JSX nodes with no innerHTML and therefore no script/HTML
// injection. Link hrefs are restricted to http(s)/mailto at parse time, so a
// `[x](javascript:…)` link degrades to plain text rather than a live link.
//
// Supported subset (enough for real-world notes, nothing more):
//   blocks   — headings (#..######), unordered/ordered lists, ``` fenced code,
//              > blockquotes, paragraphs
//   inline   — **bold** / __bold__, *italic* / _italic_, `code`, [text](url)
// Pure (no DOM, no IPC) — unit-tested in markdown.test.ts.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'bold'; c: Inline[] }
  | { t: 'italic'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: Inline[][] }
  | { t: 'code'; v: string }
  | { t: 'quote'; c: Inline[] };

// Only these schemes may become a clickable link; anything else stays text.
const SAFE_SCHEME = /^(https?:|mailto:)/i;

const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_QUOTE = /^>\s?/;
const RE_UL = /^\s*[-*]\s+/;
const RE_OL = /^\s*\d+[.)]\s+/;

function isBlockStart(line: string): boolean {
  return (
    line.trim() === '' ||
    line.trim().startsWith('```') ||
    RE_HEADING.test(line) ||
    RE_QUOTE.test(line) ||
    RE_UL.test(line) ||
    RE_OL.test(line)
  );
}

/** Parse a run of inline text into styled spans. Recurses for nested emphasis. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) {
      out.push({ t: 'text', v: buf });
      buf = '';
    }
  };

  while (i < text.length) {
    const ch = text[i];

    // `inline code` — verbatim, no nested parsing
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ t: 'code', v: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // [label](href) — only when href has a safe scheme
    if (ch === '[') {
      const close = text.indexOf(']', i + 1);
      if (close > i && text[close + 1] === '(') {
        const paren = text.indexOf(')', close + 2);
        if (paren > close) {
          const href = text.slice(close + 2, paren).trim();
          if (SAFE_SCHEME.test(href)) {
            flush();
            out.push({ t: 'link', href, c: parseInline(text.slice(i + 1, close)) });
            i = paren + 1;
            continue;
          }
        }
      }
    }

    // **bold** or __bold__
    if ((ch === '*' || ch === '_') && text[i + 1] === ch) {
      const marker = ch + ch;
      const end = text.indexOf(marker, i + 2);
      if (end > i) {
        flush();
        out.push({ t: 'bold', c: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    // *italic* or _italic_
    if (ch === '*' || ch === '_') {
      const end = text.indexOf(ch, i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: 'italic', c: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    buf += ch;
    i++;
  }

  flush();
  return out;
}

/** Parse markdown source into a flat list of blocks. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // i < lines.length guarantees `line` is defined; noUncheckedIndexedAccess
    // can't follow the loop invariant, so narrow it explicitly (never taken).
    if (line === undefined) break;

    if (line.trim() === '') {
      i++;
      continue;
    }

    // ``` fenced code block — content is verbatim until the closing fence (or EOF).
    // `cur = lines[i]` is undefined exactly when i >= lines.length, so the
    // `cur !== undefined` guard IS the bounds check.
    if (line.trim().startsWith('```')) {
      i++;
      const code: string[] = [];
      for (let cur = lines[i]; cur !== undefined && !cur.trim().startsWith('```'); cur = lines[i]) {
        code.push(cur);
        i++;
      }
      if (i < lines.length) i++; // consume the closing fence
      blocks.push({ t: 'code', v: code.join('\n') });
      continue;
    }

    const heading = RE_HEADING.exec(line);
    if (heading) {
      // Groups 1 (the #s) and 2 (the text) exist for any RE_HEADING match.
      const hashes = heading[1] ?? '';
      const text = heading[2] ?? '';
      blocks.push({ t: 'h', level: hashes.length, c: parseInline(text) });
      i++;
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const quote: string[] = [];
      for (let cur = lines[i]; cur !== undefined && RE_QUOTE.test(cur); cur = lines[i]) {
        quote.push(cur.replace(RE_QUOTE, ''));
        i++;
      }
      blocks.push({ t: 'quote', c: parseInline(quote.join(' ')) });
      continue;
    }

    if (RE_UL.test(line)) {
      const items: Inline[][] = [];
      for (let cur = lines[i]; cur !== undefined && RE_UL.test(cur); cur = lines[i]) {
        items.push(parseInline(cur.replace(RE_UL, '')));
        i++;
      }
      blocks.push({ t: 'ul', items });
      continue;
    }

    if (RE_OL.test(line)) {
      const items: Inline[][] = [];
      for (let cur = lines[i]; cur !== undefined && RE_OL.test(cur); cur = lines[i]) {
        items.push(parseInline(cur.replace(RE_OL, '')));
        i++;
      }
      blocks.push({ t: 'ol', items });
      continue;
    }

    // Paragraph: gather consecutive lines until a blank line or a block start.
    const para: string[] = [];
    for (let cur = lines[i]; cur !== undefined && cur.trim() !== '' && !isBlockStart(cur); cur = lines[i]) {
      para.push(cur);
      i++;
    }
    blocks.push({ t: 'p', c: parseInline(para.join(' ')) });
  }

  return blocks;
}
