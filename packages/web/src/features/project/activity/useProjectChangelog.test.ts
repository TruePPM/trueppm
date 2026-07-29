import { describe, expect, it } from 'vitest';
import {
  CHANGE_TYPE_META,
  DEFAULT_CHANGELOG_FILTERS,
  OBJECT_TYPE_META,
  changelogParams,
  sinceForRange,
  type ChangelogFilterState,
  type ChangelogObjectType,
  type ChangeType,
} from './useProjectChangelog';

const NOW = Date.parse('2026-07-04T00:00:00.000Z');

describe('sinceForRange', () => {
  it('returns undefined for "any time"', () => {
    expect(sinceForRange('any', NOW)).toBeUndefined();
  });

  it('computes the ISO lower bound for relative ranges', () => {
    expect(sinceForRange('24h', NOW)).toBe('2026-07-03T00:00:00.000Z');
    expect(sinceForRange('7d', NOW)).toBe('2026-06-27T00:00:00.000Z');
    expect(sinceForRange('30d', NOW)).toBe('2026-06-04T00:00:00.000Z');
  });
});

describe('changelogParams', () => {
  it('sends only page_size for the default (unfiltered) state', () => {
    expect(changelogParams(DEFAULT_CHANGELOG_FILTERS)).toEqual({ page_size: '50' });
  });

  it('serializes multi-select object and change types as sorted comma lists', () => {
    const filters: ChangelogFilterState = {
      objectTypes: new Set(['risk', 'task']),
      changeTypes: new Set(['deleted', 'created']),
      userId: null,
      range: 'any',
    };
    const params = changelogParams(filters);
    expect(params.object_type).toBe('risk,task');
    expect(params.change_type).toBe('created,deleted');
  });

  // #2517: these params go on the wire and the same strings key the TanStack
  // cache, so the emitted order must stay byte-identical to what the pre-#2517
  // bare `sort()` produced — a changed key silently orphans every cache entry
  // already written under the old one.
  //
  // Today's tokens are all lowercase ASCII, so `localeCompare` would agree with
  // code-unit order on this exact set; that agreement is a coincidence of the
  // current spelling, not a guarantee. Collation diverges on case ('A' sorts
  // before 'a' by code unit, after it by collation) and is locale-dependent
  // (['z','ä','a'] → a,ä,z in en/de but a,z,ä in sv). ChangelogObjectType
  // mirrors the server's object_type_choices and grows with it, so the ordering
  // is pinned to code units rather than left to whatever the next token and the
  // user's locale happen to produce.
  it('emits UTF-16 code-unit order, not collation order', () => {
    const params = changelogParams({
      objectTypes: new Set([
        'task_recurrence',
        'task',
        'signal_privacy_policy',
        'sprint',
        'decisions_policy',
        'dependency',
        'guardrail_policy',
        'project',
        'risk',
      ]),
      changeTypes: new Set(['updated', 'created', 'deleted']),
      userId: null,
      range: 'any',
    });
    expect(params.object_type).toBe(
      'decisions_policy,dependency,guardrail_policy,project,risk,' +
        'signal_privacy_policy,sprint,task,task_recurrence',
    );
    expect(params.change_type).toBe('created,deleted,updated');
  });

  it('emits the same string regardless of Set insertion order', () => {
    const base: ChangelogFilterState = {
      objectTypes: new Set(['task', 'dependency', 'risk']),
      changeTypes: new Set(['updated', 'created']),
      userId: null,
      range: 'any',
    };
    const reversed: ChangelogFilterState = {
      ...base,
      objectTypes: new Set(['risk', 'dependency', 'task']),
      changeTypes: new Set(['created', 'updated']),
    };
    expect(changelogParams(base).object_type).toBe(changelogParams(reversed).object_type);
    expect(changelogParams(base).change_type).toBe(changelogParams(reversed).change_type);
  });

  it('maps user and range onto user + since params', () => {
    const params = changelogParams({
      objectTypes: new Set(),
      changeTypes: new Set(),
      userId: 'u1',
      range: '24h',
    });
    expect(params.user).toBe('u1');
    expect(params.since).toBeTruthy();
  });
});

describe('display metadata', () => {
  it('has a label + icon for every object type', () => {
    const types: ChangelogObjectType[] = [
      'task',
      'sprint',
      'risk',
      'dependency',
      'project',
      'task_recurrence',
      'guardrail_policy',
      'signal_privacy_policy',
      'decisions_policy',
    ];
    for (const t of types) {
      expect(OBJECT_TYPE_META[t].label).toBeTruthy();
      expect(OBJECT_TYPE_META[t].icon).toBeTruthy();
    }
  });

  it('has a verb + semantic tint for every change type', () => {
    const types: ChangeType[] = ['created', 'updated', 'deleted'];
    for (const t of types) {
      expect(CHANGE_TYPE_META[t].verb).toBeTruthy();
      expect(CHANGE_TYPE_META[t].tint).toMatch(/^text-/);
    }
  });
});
