import { describe, expect, it } from 'vitest';
import { matchKindFor, matchesQuery } from '../ScheduleDependencyPicker';

describe('matchesQuery — a planner types two different things', () => {
  it('reads a leading digit as a WBS PREFIX', () => {
    expect(matchesQuery('Permits', '1.1', '1.')).toBe(true);
    expect(matchesQuery('Cable pull', '2.1', '1.')).toBe(false);
  });

  it('does not let a prefix query match names', () => {
    // The reason the distinction exists: `1.` as a loose substring returns every
    // task whose title contains a 1, burying the phase that was asked for.
    expect(matchesQuery('Phase 1 kickoff', '9.9', '1')).toBe(false);
  });

  it('reads anything else as a name substring', () => {
    expect(matchesQuery('Lay-down area survey', '3.2', 'lay')).toBe(true);
    expect(matchesQuery('Lay-down area survey', '3.2', 'survey')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesQuery('Lay-down area survey', '3.2', 'LAY')).toBe(true);
  });

  it('matches everything on an empty query', () => {
    expect(matchesQuery('Anything', '1.1', '   ')).toBe(true);
  });
});

describe('matchKindFor — the reason a row is in the list', () => {
  it('reads a leading digit as a WBS prefix', () => {
    expect(matchKindFor('1.')).toBe('wbs-prefix');
    expect(matchKindFor('  2 ')).toBe('wbs-prefix');
  });

  it('reads anything else as a name substring', () => {
    expect(matchKindFor('lay')).toBe('name-substring');
    expect(matchKindFor('-1')).toBe('name-substring');
  });

  it('reads an empty query as no reason at all', () => {
    expect(matchKindFor('')).toBe('none');
    expect(matchKindFor('   ')).toBe('none');
  });

  it('agrees with matchesQuery on every case, which is the point of deriving it', () => {
    // The mark states WHY a row matched. If the kind and the filter could
    // disagree, the mark would land on a field the filter never consulted.
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['Permits', '1.1', '1.'],
      ['Cable pull', '2.1', '1.'],
      ['Lay-down area survey', '3.4', 'lay'],
      ['Permits', '1.1', ''],
    ];
    for (const [name, wbs, query] of cases) {
      const kind = matchKindFor(query);
      const matched = matchesQuery(name, wbs, query);
      if (kind === 'none') expect(matched).toBe(true);
      if (kind === 'wbs-prefix') expect(matched).toBe(wbs.toLowerCase().startsWith(query.trim().toLowerCase()));
      if (kind === 'name-substring')
        expect(matched).toBe(name.toLowerCase().includes(query.trim().toLowerCase()));
    }
  });
});
