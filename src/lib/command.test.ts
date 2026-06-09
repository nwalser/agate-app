import { describe, expect, it } from 'vitest';
import {
  type Command,
  commandTerm,
  fuzzyMatch,
  isCommandQuery,
  rankCommands,
  spansFor,
} from './command.ts';

function cmd(id: string, label: string): Command {
  return { id, label, run: () => {} };
}

describe('isCommandQuery / commandTerm', () => {
  it('detects the `/` prefix', () => {
    expect(isCommandQuery('/sync')).toBe(true);
    expect(isCommandQuery('sync')).toBe(false);
    expect(isCommandQuery('')).toBe(false);
  });

  it('strips the leading slash only in command mode', () => {
    expect(commandTerm('/new login')).toBe('new login');
    expect(commandTerm('/')).toBe('');
    expect(commandTerm('github')).toBe('github');
  });
});

describe('fuzzyMatch', () => {
  it('matches a subsequence and reports its indices', () => {
    const res = fuzzyMatch('GitHub', 'gh');
    expect(res.hit).toBe(true);
    expect(res.indices).toEqual([0, 3]);
  });

  it('misses when a character is absent or out of order', () => {
    expect(fuzzyMatch('GitHub', 'xyz').hit).toBe(false);
    expect(fuzzyMatch('GitHub', 'hg').hit).toBe(false);
  });

  it('treats an empty query as a zero-score match', () => {
    expect(fuzzyMatch('anything', '')).toEqual({ hit: true, score: 0, indices: [] });
  });

  it('scores contiguous and earlier matches higher', () => {
    // Contiguous prefix beats a scattered match of the same letters.
    expect(fuzzyMatch('login', 'log').score).toBeGreaterThan(fuzzyMatch('lawful dog', 'log').score);
  });
});

describe('spansFor', () => {
  it('returns a single unmatched span when nothing matched', () => {
    expect(spansFor('Sync now', [])).toEqual([{ text: 'Sync now', matched: false }]);
  });

  it('splits the label into matched / unmatched runs', () => {
    expect(spansFor('GitHub', [0, 3])).toEqual([
      { text: 'G', matched: true },
      { text: 'it', matched: false },
      { text: 'H', matched: true },
      { text: 'ub', matched: false },
    ]);
  });
});

describe('rankCommands', () => {
  const commands = [cmd('a', 'Sync now'), cmd('b', 'Open Settings'), cmd('c', 'Lock vault')];

  it('keeps input order for an empty query', () => {
    expect(rankCommands(commands, '').map((r) => r.command.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops non-matching commands', () => {
    const ranked = rankCommands(commands, 'set');
    expect(ranked.map((r) => r.command.id)).toEqual(['b']);
  });

  it('ranks the best subsequence match first', () => {
    // "lo" is a contiguous prefix of "Lock", only scattered in the others.
    expect(rankCommands(commands, 'lo')[0].command.id).toBe('c');
  });

  it('carries highlight spans for the matched command', () => {
    const [first] = rankCommands(commands, 'lock');
    expect(first.spans[0]).toEqual({ text: 'Lock', matched: true });
  });
});
