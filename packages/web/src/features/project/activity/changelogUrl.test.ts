import { describe, expect, it } from 'vitest';
import {
  clickThroughPath,
  filtersToSearchParams,
  searchParamsToFilters,
} from './changelogUrl';
import {
  DEFAULT_CHANGELOG_FILTERS,
  type ChangelogEntry,
  type ChangelogFilterState,
} from './useProjectChangelog';

function entry(over: Partial<ChangelogEntry>): ChangelogEntry {
  return {
    id: 'task:1',
    object_type: 'task',
    object_id: 'obj-1',
    object_label: 'X',
    change_type: 'updated',
    history_date: '2026-07-01T00:00:00Z',
    user: null,
    changes: [],
    ...over,
  };
}

describe('filtersToSearchParams / searchParamsToFilters', () => {
  it('omits every default (clean links)', () => {
    expect(filtersToSearchParams(DEFAULT_CHANGELOG_FILTERS).toString()).toBe('');
  });

  it('round-trips a fully-populated filter state', () => {
    const filters: ChangelogFilterState = {
      objectTypes: new Set(['task', 'risk']),
      changeTypes: new Set(['created', 'deleted']),
      userId: 'user-9',
      range: '7d',
    };
    const params = filtersToSearchParams(filters);
    const back = searchParamsToFilters(params);
    expect([...back.objectTypes].sort()).toEqual(['risk', 'task']);
    expect([...back.changeTypes].sort()).toEqual(['created', 'deleted']);
    expect(back.userId).toBe('user-9');
    expect(back.range).toBe('7d');
  });

  it('drops unknown object/change tokens and coerces a bad range to "any"', () => {
    const params = new URLSearchParams('type=task,banana&change=exploded,created&range=nope');
    const back = searchParamsToFilters(params);
    expect([...back.objectTypes]).toEqual(['task']);
    expect([...back.changeTypes]).toEqual(['created']);
    expect(back.range).toBe('any');
  });

  it('treats an empty user param as null', () => {
    expect(searchParamsToFilters(new URLSearchParams('user=')).userId).toBeNull();
  });
});

describe('clickThroughPath', () => {
  it('deep-links a task to its detail route', () => {
    expect(clickThroughPath('p1', entry({ object_type: 'task', object_id: 't9' }))).toBe(
      '/projects/p1/tasks/t9',
    );
  });

  it('routes each non-task object type to its closest surface', () => {
    // risk/sprint deep-link to the specific item so the surface opens it (#2046).
    expect(clickThroughPath('p1', entry({ object_type: 'risk', object_id: 'obj-1' }))).toBe(
      '/projects/p1/risk?risk=obj-1',
    );
    expect(clickThroughPath('p1', entry({ object_type: 'sprint', object_id: 'obj-1' }))).toBe(
      '/projects/p1/sprints?sprint=obj-1',
    );
    expect(clickThroughPath('p1', entry({ object_type: 'dependency' }))).toBe(
      '/projects/p1/schedule',
    );
    expect(clickThroughPath('p1', entry({ object_type: 'task_recurrence' }))).toBe(
      '/projects/p1/schedule',
    );
    expect(clickThroughPath('p1', entry({ object_type: 'project' }))).toBe('/projects/p1/settings');
    expect(clickThroughPath('p1', entry({ object_type: 'guardrail_policy' }))).toBe(
      '/projects/p1/settings',
    );
    expect(clickThroughPath('p1', entry({ object_type: 'signal_privacy_policy' }))).toBe(
      '/projects/p1/settings',
    );
    expect(clickThroughPath('p1', entry({ object_type: 'decisions_policy' }))).toBe(
      '/projects/p1/settings',
    );
  });
});
