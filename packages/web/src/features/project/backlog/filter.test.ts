import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import {
  EMPTY_GROOMING_FILTERS,
  countStories,
  filterBacklog,
  filterStories,
  isFilterActive,
  isUnestimated,
  matchesFilters,
  matchesStorySearch,
  normalize,
  type GroomingFilters,
} from './filter';
import type { ProductBacklog } from './types';

function story(overrides: Partial<Task>): Task {
  return {
    id: 'T-001',
    name: 'Untitled',
    taskType: 'story',
    dor: 'idea',
    storyPoints: null,
    serverVersion: 1,
    ...overrides,
  } as Task;
}

describe('normalize', () => {
  it('strips diacritics and lowercases', () => {
    expect(normalize('Crème Brûlée')).toBe('creme brulee');
  });
});

describe('matchesStorySearch', () => {
  it('matches case- and accent-insensitively on the title', () => {
    const s = story({ name: 'Pólaris coordination' });
    expect(matchesStorySearch(s, 'polaris')).toBe(true);
    expect(matchesStorySearch(s, 'COORD')).toBe(true);
    expect(matchesStorySearch(s, 'telemetry')).toBe(false);
  });

  it('treats a blank query as a match', () => {
    expect(matchesStorySearch(story({}), '   ')).toBe(true);
  });

  it('searches the title only, not the description/notes', () => {
    expect(matchesStorySearch(story({ name: 'A', notes: 'secret' }), 'secret')).toBe(false);
  });
});

describe('isUnestimated', () => {
  it('is true only when storyPoints is null/undefined', () => {
    expect(isUnestimated(story({ storyPoints: null }))).toBe(true);
    expect(isUnestimated(story({ storyPoints: undefined }))).toBe(true);
    expect(isUnestimated(story({ storyPoints: 0 }))).toBe(false);
    expect(isUnestimated(story({ storyPoints: 3 }))).toBe(false);
  });
});

describe('matchesFilters', () => {
  it('filters by DoR state (OR within the facet)', () => {
    const ready = story({ dor: 'ready' });
    const refine = story({ dor: 'refine' });
    const idea = story({ dor: 'idea' });
    const f: GroomingFilters = { ...EMPTY_GROOMING_FILTERS, dorStates: ['ready', 'refine'] };
    expect(matchesFilters(ready, f)).toBe(true);
    expect(matchesFilters(refine, f)).toBe(true);
    expect(matchesFilters(idea, f)).toBe(false);
  });

  it('treats a missing dor as "idea"', () => {
    const s = story({ dor: undefined });
    expect(matchesFilters(s, { ...EMPTY_GROOMING_FILTERS, dorStates: ['idea'] })).toBe(true);
    expect(matchesFilters(s, { ...EMPTY_GROOMING_FILTERS, dorStates: ['ready'] })).toBe(false);
  });

  it('keeps only unestimated stories when the toggle is on', () => {
    const est = story({ storyPoints: 5 });
    const unest = story({ storyPoints: null });
    const f: GroomingFilters = { ...EMPTY_GROOMING_FILTERS, unestimatedOnly: true };
    expect(matchesFilters(est, f)).toBe(false);
    expect(matchesFilters(unest, f)).toBe(true);
  });

  it('combines search + DoR + unestimated with AND', () => {
    const a = story({ name: 'Telemetry link', dor: 'refine', storyPoints: null });
    const b = story({ name: 'Telemetry harness', dor: 'ready', storyPoints: null });
    const c = story({ name: 'Telemetry link', dor: 'refine', storyPoints: 5 });
    const f: GroomingFilters = {
      query: 'telemetry',
      dorStates: ['refine'],
      unestimatedOnly: true,
    };
    expect(matchesFilters(a, f)).toBe(true);
    expect(matchesFilters(b, f)).toBe(false); // wrong DoR
    expect(matchesFilters(c, f)).toBe(false); // estimated
  });
});

describe('filterStories', () => {
  it('narrows a flat list by the active filters', () => {
    const set = [
      story({ id: 'x', name: 'Failover handling', dor: 'ready', storyPoints: 5 }),
      story({ id: 'y', name: 'Signal smoothing', dor: 'refine', storyPoints: null }),
      story({ id: 'z', name: 'Loose investigation', dor: 'idea', storyPoints: null }),
    ];
    expect(filterStories(set, { ...EMPTY_GROOMING_FILTERS, query: 'signal' }).map((s) => s.id)).toEqual([
      'y',
    ]);
    expect(
      filterStories(set, { ...EMPTY_GROOMING_FILTERS, unestimatedOnly: true }).map((s) => s.id),
    ).toEqual(['y', 'z']);
    expect(
      filterStories(set, { ...EMPTY_GROOMING_FILTERS, dorStates: ['ready'] }).map((s) => s.id),
    ).toEqual(['x']);
  });
});

describe('isFilterActive', () => {
  it('is false for the empty filter and true when any facet is engaged', () => {
    expect(isFilterActive(EMPTY_GROOMING_FILTERS)).toBe(false);
    expect(isFilterActive({ ...EMPTY_GROOMING_FILTERS, query: '  ' })).toBe(false);
    expect(isFilterActive({ ...EMPTY_GROOMING_FILTERS, query: 'x' })).toBe(true);
    expect(isFilterActive({ ...EMPTY_GROOMING_FILTERS, dorStates: ['ready'] })).toBe(true);
    expect(isFilterActive({ ...EMPTY_GROOMING_FILTERS, unestimatedOnly: true })).toBe(true);
  });
});

describe('filterBacklog / countStories', () => {
  const backlog: ProductBacklog = {
    epics: [
      {
        epic: story({ id: 'EP1', name: 'Telemetry', taskType: 'epic' }),
        stories: [
          story({ id: 'S1', name: 'Failover handling', dor: 'ready', storyPoints: 5 }),
          story({ id: 'S2', name: 'Signal smoothing', dor: 'refine', storyPoints: null }),
        ],
        rollup: { storyCount: 2, pointsTotal: 5, pointsDone: 0 },
      },
      {
        epic: story({ id: 'EP2', name: 'Empty epic', taskType: 'epic' }),
        stories: [story({ id: 'S3', name: 'Done work', dor: 'ready', storyPoints: 8 })],
        rollup: { storyCount: 1, pointsTotal: 8, pointsDone: 0 },
      },
    ],
    ungrouped: [story({ id: 'S4', name: 'Loose investigation', dor: 'idea', storyPoints: null })],
    health: {
      dorPct: 0,
      readyCount: 0,
      readyPoints: 0,
      capacityPoints: null,
      unestimated: 2,
      acMet: 0,
      acTotal: 0,
      storyCount: 4,
    },
    scoring: { model: 'none' },
  };

  it('counts every story across epics + ungrouped', () => {
    expect(countStories(backlog)).toBe(4);
  });

  it('drops epic groups with no surviving stories and filters the ungrouped bucket', () => {
    const { epics, ungrouped, matchCount } = filterBacklog(backlog, {
      ...EMPTY_GROOMING_FILTERS,
      unestimatedOnly: true,
    });
    // Only S2 (in EP1) and S4 (ungrouped) are unestimated; EP2 drops out entirely.
    expect(epics.map((g) => g.epic.id)).toEqual(['EP1']);
    expect(epics[0].stories.map((s) => s.id)).toEqual(['S2']);
    expect(ungrouped.map((s) => s.id)).toEqual(['S4']);
    expect(matchCount).toBe(2);
  });

  it('returns the full backlog shape when no filter is active', () => {
    const { epics, ungrouped, matchCount } = filterBacklog(backlog, EMPTY_GROOMING_FILTERS);
    expect(epics).toHaveLength(2);
    expect(ungrouped).toHaveLength(1);
    expect(matchCount).toBe(4);
  });
});
