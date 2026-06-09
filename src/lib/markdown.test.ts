import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, type Block } from './markdown.ts';

describe('parseInline', () => {
  it('returns plain text as a single text node', () => {
    expect(parseInline('hello world')).toEqual([{ t: 'text', v: 'hello world' }]);
  });

  it('parses bold and italic', () => {
    expect(parseInline('**b**')).toEqual([{ t: 'bold', c: [{ t: 'text', v: 'b' }] }]);
    expect(parseInline('_i_')).toEqual([{ t: 'italic', c: [{ t: 'text', v: 'i' }] }]);
  });

  it('parses inline code verbatim (no nested markup)', () => {
    expect(parseInline('`a*b*c`')).toEqual([{ t: 'code', v: 'a*b*c' }]);
  });

  it('parses a safe http link', () => {
    expect(parseInline('[x](https://a.com)')).toEqual([
      { t: 'link', href: 'https://a.com', c: [{ t: 'text', v: 'x' }] },
    ]);
  });

  it('refuses an unsafe-scheme link and keeps it as text (XSS guard)', () => {
    const out = parseInline('[x](javascript:alert(1))');
    expect(out.every((n) => n.t !== 'link')).toBe(true);
  });

  it('does not treat raw html as markup — it stays literal text', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([
      { t: 'text', v: '<img src=x onerror=alert(1)>' },
    ]);
  });
});

describe('parseMarkdown', () => {
  const kinds = (blocks: Block[]) => blocks.map((b) => b.t);

  it('parses headings with their level', () => {
    const [b] = parseMarkdown('### Title');
    expect(b).toMatchObject({ t: 'h', level: 3 });
  });

  it('groups consecutive bullet lines into one list', () => {
    const blocks = parseMarkdown('- one\n- two\n- three');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ t: 'ul' });
    expect((blocks[0] as Extract<Block, { t: 'ul' }>).items).toHaveLength(3);
  });

  it('parses ordered lists', () => {
    const blocks = parseMarkdown('1. a\n2. b');
    expect(blocks[0]).toMatchObject({ t: 'ol' });
  });

  it('captures fenced code verbatim', () => {
    const blocks = parseMarkdown('```\nlet x = *not bold*\n```');
    expect(blocks[0]).toEqual({ t: 'code', v: 'let x = *not bold*' });
  });

  it('parses a blockquote', () => {
    expect(parseMarkdown('> quoted')[0]).toMatchObject({ t: 'quote' });
  });

  it('separates blocks across blank lines and mixes types', () => {
    const blocks = parseMarkdown('# H\n\npara text\n\n- item');
    expect(kinds(blocks)).toEqual(['h', 'p', 'ul']);
  });

  it('joins consecutive plain lines into one paragraph', () => {
    const blocks = parseMarkdown('line one\nline two');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ t: 'p' });
  });
});
