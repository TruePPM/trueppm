import { describe, expect, it } from 'vitest';
import { matchesQuery } from '../ScheduleDependencyPicker';

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
