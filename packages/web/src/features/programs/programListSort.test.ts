import { beforeEach, describe, expect, it } from 'vitest';
import type { Program } from '@/api/types';
import {
  DEFAULT_PROGRAM_SORT,
  filterAndSortPrograms,
  readProgramSortPref,
  writeProgramSortPref,
} from './programListSort';

function makeProgram(overrides: Partial<Program>): Program {
  // Only the fields the sort/filter logic reads matter; cast satisfies the rest.
  return {
    id: 'p',
    name: 'Program',
    code: '',
    description: '',
    methodology: 'HYBRID',
    health: 'AUTO',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Program;
}

const alpha = makeProgram({
  id: 'a',
  name: 'Alpha',
  code: 'ALP',
  description: 'billing rewrite',
  methodology: 'WATERFALL',
  health: 'ON_TRACK',
  updated_at: '2026-03-01T00:00:00Z',
});
const bravo = makeProgram({
  id: 'b',
  name: 'Bravo',
  code: 'BRV',
  description: 'mobile app',
  methodology: 'AGILE',
  health: 'CRITICAL',
  updated_at: '2026-05-01T00:00:00Z',
});
const charlie = makeProgram({
  id: 'c',
  name: 'Charlie',
  code: 'CHR',
  description: 'data platform',
  methodology: 'HYBRID',
  health: 'AT_RISK',
  updated_at: '2026-02-01T00:00:00Z',
});

const ALL = [alpha, bravo, charlie];

function ids(programs: Program[]): string[] {
  return programs.map((p) => p.id);
}

describe('filterAndSortPrograms', () => {
  it('sorts by recently active (updated_at desc) by default', () => {
    const out = filterAndSortPrograms(ALL, {
      query: '',
      methodology: 'ALL',
      sortKey: 'recent',
    });
    expect(ids(out)).toEqual(['b', 'a', 'c']);
  });

  it('sorts by name A→Z', () => {
    const out = filterAndSortPrograms([charlie, alpha, bravo], {
      query: '',
      methodology: 'ALL',
      sortKey: 'name',
    });
    expect(ids(out)).toEqual(['a', 'b', 'c']);
  });

  it('sorts by health worst-first (Critical → At risk → On track)', () => {
    const out = filterAndSortPrograms(ALL, {
      query: '',
      methodology: 'ALL',
      sortKey: 'health',
    });
    expect(ids(out)).toEqual(['b', 'c', 'a']);
  });

  it('is pin-agnostic — the chosen sort is the only thing that moves a row', () => {
    // Charlie IS pinned, and still sorts last alphabetically. Floating pins
    // inside the sort was the old behavior and it read as a broken sort: a row
    // jumped the queue with nothing on screen to explain why. `ProgramListPage`
    // lifts pins into a labelled group instead (#2390, design §5.2), so this
    // function returns one honest ordering.
    const pinnedCharlie = { ...charlie, is_pinned: true };
    const out = filterAndSortPrograms([alpha, bravo, pinnedCharlie], {
      query: '',
      methodology: 'ALL',
      sortKey: 'name',
    });
    expect(ids(out)).toEqual(['a', 'b', 'c']);
  });

  it('filters by name (case-insensitive substring)', () => {
    const out = filterAndSortPrograms(ALL, {
      query: 'brav',
      methodology: 'ALL',
      sortKey: 'recent',
    });
    expect(ids(out)).toEqual(['b']);
  });

  it('filters by code and description too', () => {
    expect(
      ids(
        filterAndSortPrograms(ALL, {
          query: 'CHR',
          methodology: 'ALL',
          sortKey: 'recent',
        }),
      ),
    ).toEqual(['c']);
    expect(
      ids(
        filterAndSortPrograms(ALL, {
          query: 'billing',
          methodology: 'ALL',
          sortKey: 'recent',
        }),
      ),
    ).toEqual(['a']);
  });

  it('narrows by methodology facet', () => {
    const out = filterAndSortPrograms(ALL, {
      query: '',
      methodology: 'AGILE',
      sortKey: 'recent',
    });
    expect(ids(out)).toEqual(['b']);
  });

  it('combines query and methodology (intersection)', () => {
    const out = filterAndSortPrograms(ALL, {
      query: 'a',
      methodology: 'WATERFALL',
      sortKey: 'recent',
    });
    expect(ids(out)).toEqual(['a']);
  });

  it('returns an empty array when nothing matches', () => {
    const out = filterAndSortPrograms(ALL, {
      query: 'zzz-no-such-program',
      methodology: 'ALL',
      sortKey: 'recent',
    });
    expect(out).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [...ALL];
    filterAndSortPrograms(input, {
      query: '',
      methodology: 'ALL',
      sortKey: 'name',
    });
    expect(ids(input)).toEqual(['a', 'b', 'c']);
  });
});

describe('program sort preference persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to recently active when unset', () => {
    expect(readProgramSortPref()).toBe(DEFAULT_PROGRAM_SORT);
    expect(DEFAULT_PROGRAM_SORT).toBe('recent');
  });

  it('round-trips a written preference', () => {
    writeProgramSortPref('health');
    expect(readProgramSortPref()).toBe('health');
  });

  it('ignores a corrupt stored value and falls back to the default', () => {
    localStorage.setItem('trueppm.programs.sort', 'not-a-key');
    expect(readProgramSortPref()).toBe(DEFAULT_PROGRAM_SORT);
  });
});
