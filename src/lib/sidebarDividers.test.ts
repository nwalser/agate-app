// Labeled sidebar dividers + redundant-divider collapsing. Dividers used to be bare
// lines with no definition, visually identical to the pinned Settings separator and
// prone to stacking/edge artefacts ("don't work perfectly"). They now carry an
// optional section label and resolve through `resolveSidebar`, which drops cosmetic
// dividers (leading, trailing, doubled) while always keeping labeled section heads.

import { describe, expect, it } from 'vitest';
import {
  type CustomQuery,
  type SidebarConfig,
  parseDividerLabels,
  reconcile,
  resolveSidebar,
} from './sidebarConfig.ts';

const cfg = (over: Partial<SidebarConfig> = {}): SidebarConfig => ({
  order: [],
  hidden: [],
  queries: [],
  dividerLabels: {},
  ...over,
});

const q: CustomQuery = {
  id: 'query:1',
  name: 'AWS',
  icon: 'bookmark',
  config: { filter: { kind: 'all' }, query: '', columnFilters: {} },
};

describe('parseDividerLabels', () => {
  it('keeps only string values', () => {
    expect(parseDividerLabels({ 'divider:1': 'Work', 'divider:2': 42, x: null })).toEqual({
      'divider:1': 'Work',
    });
  });

  it('returns an empty map for non-objects', () => {
    expect(parseDividerLabels(null)).toEqual({});
    expect(parseDividerLabels('nope')).toEqual({});
  });
});

describe('reconcile — divider labels', () => {
  it('keeps a label only for a divider still present in order, dropping empties', () => {
    const out = reconcile({
      order: ['all', 'divider:1'],
      hidden: [],
      queries: [],
      dividerLabels: { 'divider:1': 'Work', 'divider:gone': 'Stale', 'divider:empty': '' },
    });
    expect(out.dividerLabels).toEqual({ 'divider:1': 'Work' });
  });

  it('defaults dividerLabels to an empty map when omitted', () => {
    const out = reconcile({ order: ['all'], hidden: [], queries: [] });
    expect(out.dividerLabels).toEqual({});
  });
});

describe('resolveSidebar', () => {
  it('drops hidden ids and resolves builtins/queries/dividers', () => {
    const out = resolveSidebar(
      cfg({ order: ['all', 'query:1', 'trash'], hidden: ['trash'], queries: [q] }),
    );
    expect(out).toEqual([
      { kind: 'builtin', id: 'all' },
      { kind: 'query', query: q },
    ]);
  });

  it('attaches a divider section label', () => {
    const out = resolveSidebar(
      cfg({ order: ['all', 'divider:1', 'favorites'], dividerLabels: { 'divider:1': 'Work' } }),
    );
    expect(out[1]).toEqual({ kind: 'divider', id: 'divider:1', label: 'Work' });
  });

  it('collapses a leading, doubled, and trailing unlabeled divider', () => {
    const out = resolveSidebar(
      cfg({ order: ['divider:a', 'all', 'divider:b', 'divider:c', 'favorites', 'divider:d'] }),
    );
    expect(out.map((e) => (e.kind === 'divider' ? `div` : (e as { id: string }).id))).toEqual([
      'all',
      'div', // only one of the doubled b/c survives
      'favorites',
    ]);
  });

  it('always keeps labeled dividers, even at the edges', () => {
    const out = resolveSidebar(
      cfg({
        order: ['divider:top', 'all', 'divider:bot'],
        dividerLabels: { 'divider:top': 'Top', 'divider:bot': 'Bottom' },
      }),
    );
    expect(out[0]).toEqual({ kind: 'divider', id: 'divider:top', label: 'Top' });
    expect(out[out.length - 1]).toEqual({ kind: 'divider', id: 'divider:bot', label: 'Bottom' });
  });
});
