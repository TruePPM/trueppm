import { describe, expect, it } from 'vitest';
import {
  countByStatus,
  distinctTags,
  filterItems,
  matchesSearch,
  nextPriorityRank,
  normalize,
  sortItems,
  splitPulled,
  type BacklogFilters,
} from './filter';
import type { BacklogItem } from './types';

function item(overrides: Partial<BacklogItem>): BacklogItem {
  return {
    id: 'BI-001',
    programId: 'p',
    title: 'Untitled',
    itemType: 'story',
    status: 'PROPOSED',
    tags: [],
    priorityRank: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const noFilters: BacklogFilters = { query: '', status: null, types: [], tags: [] };

describe('matchesSearch', () => {
  it('matches case- and accent-insensitively on the title', () => {
    const i = item({ title: 'Pólaris coordination' });
    expect(matchesSearch(i, 'polaris')).toBe(true);
    expect(matchesSearch(i, 'COORD')).toBe(true);
    expect(matchesSearch(i, 'telemetry')).toBe(false);
  });

  it('treats an empty query as a match', () => {
    expect(matchesSearch(item({}), '   ')).toBe(true);
  });

  it('does not search the description', () => {
    expect(matchesSearch(item({ title: 'A', description: 'secret' }), 'secret')).toBe(false);
  });
});

describe('normalize', () => {
  it('strips diacritics and lowercases', () => {
    expect(normalize('Crème Brûlée')).toBe('creme brulee');
  });
});

describe('filterItems', () => {
  const items = [
    item({ id: 'a', status: 'PROPOSED', itemType: 'epic', tags: ['safety'] }),
    item({ id: 'b', status: 'PULLED', itemType: 'story', tags: ['ground'] }),
    item({ id: 'c', status: 'ARCHIVED', itemType: 'bug', tags: ['ground', 'safety'] }),
  ];

  it('hides ARCHIVED items in the default "All" view', () => {
    const result = filterItems(items, noFilters);
    expect(result.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('shows only the chosen status when a status filter is set', () => {
    expect(filterItems(items, { ...noFilters, status: 'ARCHIVED' }).map((i) => i.id)).toEqual([
      'c',
    ]);
  });

  it('filters by type (OR within the facet)', () => {
    expect(
      filterItems(items, { ...noFilters, status: null, types: ['epic', 'bug'] }).map((i) => i.id),
    ).toEqual(['a']); // bug is archived → hidden in All view
  });

  it('requires every selected tag (AND within the facet)', () => {
    const result = filterItems(items, {
      ...noFilters,
      status: 'ARCHIVED',
      tags: ['ground', 'safety'],
    });
    expect(result.map((i) => i.id)).toEqual(['c']);
    expect(
      filterItems(items, { ...noFilters, status: null, tags: ['ground', 'safety'] }).map(
        (i) => i.id,
      ),
    ).toEqual([]); // a has only safety, b only ground
  });

  it('combines facets and search with AND', () => {
    const set = [
      item({ id: 'x', title: 'Telemetry link', itemType: 'story', tags: ['arch'] }),
      item({ id: 'y', title: 'Telemetry harness', itemType: 'spike', tags: ['arch'] }),
    ];
    const result = filterItems(set, {
      query: 'telemetry',
      status: null,
      types: ['story'],
      tags: ['arch'],
    });
    expect(result.map((i) => i.id)).toEqual(['x']);
  });
});

describe('sortItems', () => {
  it('sorts by priorityRank asc, then createdAt desc within a rank', () => {
    const set = [
      item({ id: 'low', priorityRank: 3 }),
      item({ id: 'old', priorityRank: 1, createdAt: '2026-01-01T00:00:00Z' }),
      item({ id: 'new', priorityRank: 1, createdAt: '2026-02-01T00:00:00Z' }),
    ];
    expect(sortItems(set).map((i) => i.id)).toEqual(['new', 'old', 'low']);
  });
});

describe('splitPulled', () => {
  const set = [item({ id: 'a', status: 'PROPOSED' }), item({ id: 'b', status: 'PULLED' })];

  it('peels PULLED items into their own group in the default view', () => {
    const { main, pulled } = splitPulled(set, null);
    expect(main.map((i) => i.id)).toEqual(['a']);
    expect(pulled.map((i) => i.id)).toEqual(['b']);
  });

  it('keeps everything in main when a status filter is active', () => {
    const { main, pulled } = splitPulled(set, 'PULLED');
    expect(main).toHaveLength(2);
    expect(pulled).toHaveLength(0);
  });
});

describe('countByStatus / distinctTags / nextPriorityRank', () => {
  const set = [
    item({ status: 'PROPOSED', tags: ['b', 'a'], priorityRank: 2 }),
    item({ status: 'PROPOSED', tags: ['a'], priorityRank: 5 }),
    item({ status: 'PULLED', tags: ['c'], priorityRank: 1 }),
  ];

  it('counts each status and the total', () => {
    expect(countByStatus(set)).toEqual({ all: 3, proposed: 2, pulled: 1, archived: 0 });
  });

  it('returns sorted distinct tags', () => {
    expect(distinctTags(set)).toEqual(['a', 'b', 'c']);
  });

  it('returns max rank + 1', () => {
    expect(nextPriorityRank(set)).toBe(6);
    expect(nextPriorityRank([])).toBe(1);
  });
});
