import { describe, it, expect } from 'vitest';
import type { ProjectResource } from '@/types';
import {
  activeOwnerQuery,
  matchRosterMember,
  ownerTokensToApiPayload,
  parseOwnerDraft,
  parseOwnerTokens,
  segmentUnresolvedOwners,
} from './ownerToken';

function member(id: string, name: string): ProjectResource {
  return {
    id: `pr-${id}`,
    projectId: 'p1',
    resourceId: id,
    resource: {
      id,
      name,
      email: `${id}@example.com`,
      jobRole: '',
      maxUnits: 1,
      calendarId: null,
      skills: [],
    },
    roleTitle: '',
    unitsOverride: null,
    effectiveMaxUnits: 1,
    notes: '',
  } as ProjectResource;
}

const ANA = member('r-ana', 'Ana Rivera');
const BEN = member('r-ben', 'Ben Okafor');
const ANA_S = member('r-anas', 'Ana Silva');
const POOL = [ANA, BEN];

describe('parseOwnerTokens', () => {
  it('parses a bare @name at the default 100%', () => {
    expect(parseOwnerTokens('Draft plan @ana')).toEqual([
      { raw: '@ana', query: 'ana', units: 100, start: 11 },
    ]);
  });

  it('parses @ana:50 to 50 — the percent form, not a fraction', () => {
    const [token] = parseOwnerTokens('Draft plan @ana:50');
    expect(token.units).toBe(50);
    expect(token.query).toBe('ana');
  });

  it('supports a quoted multi-word name', () => {
    const [token] = parseOwnerTokens('Kickoff @"Ana Rivera":25');
    expect(token.query).toBe('Ana Rivera');
    expect(token.units).toBe(25);
  });

  it('clamps an out-of-range percent into the API allocation bounds', () => {
    expect(parseOwnerTokens('@ana:0')[0].units).toBe(1);
    expect(parseOwnerTokens('@ana:999')[0].units).toBe(200);
  });

  it('finds every token in a draft, not just the first', () => {
    expect(parseOwnerTokens('Review @ana:50 @ben').map((t) => t.query)).toEqual(['ana', 'ben']);
  });

  it('is reentrant — a second call on the same input returns the same tokens', () => {
    // Guards the classic /g-regex lastIndex bug, where every other call finds nothing.
    expect(parseOwnerTokens('@ana')).toEqual(parseOwnerTokens('@ana'));
  });
});

describe('matchRosterMember', () => {
  it('matches case-insensitively on a unique prefix', () => {
    expect(matchRosterMember('ana', POOL)?.resourceId).toBe('r-ana');
    expect(matchRosterMember('BEN', POOL)?.resourceId).toBe('r-ben');
  });

  it('prefers an exact name over a prefix that would also match', () => {
    const pool = [member('r-an', 'An'), ANA];
    expect(matchRosterMember('An', pool)?.resourceId).toBe('r-an');
  });

  it('resolves to nothing when the query is ambiguous', () => {
    // Binding work to the wrong person silently is the failure this whole contract
    // exists to prevent — an ambiguous token must stay unresolved and visible.
    expect(matchRosterMember('ana', [ANA, ANA_S])).toBeNull();
  });

  it('never reaches outside the supplied roster', () => {
    expect(matchRosterMember('ana', [BEN])).toBeNull();
  });
});

describe('parseOwnerDraft', () => {
  it('emits {resourceId, units} and strips the token from the committed name', () => {
    const parse = parseOwnerDraft('Draft the migration plan @ana:50', POOL);
    expect(parse.owners).toEqual([{ resourceId: 'r-ana', name: 'Ana Rivera', units: 50 }]);
    expect(parse.name).toBe('Draft the migration plan');
    expect(parse.unresolved).toEqual([]);
  });

  it('defaults a bare token to 100%', () => {
    expect(parseOwnerDraft('Plan @ben', POOL).owners[0].units).toBe(100);
  });

  it('leaves an unmatched name as literal text and flags the row unresolved', () => {
    const parse = parseOwnerDraft('Plan @nobody', POOL);
    expect(parse.owners).toEqual([]);
    expect(parse.unresolved.map((t) => t.raw)).toEqual(['@nobody']);
    // The literal text survives: the row commits, and the author can see and fix it.
    expect(parse.name).toBe('Plan @nobody');
  });

  it('resolves what it can and leaves the rest unresolved in the same draft', () => {
    const parse = parseOwnerDraft('Plan @ana @nobody', POOL);
    expect(parse.owners.map((o) => o.resourceId)).toEqual(['r-ana']);
    expect(parse.unresolved.map((t) => t.query)).toEqual(['nobody']);
    expect(parse.name).toBe('Plan @nobody');
  });

  it('treats a repeated person as a correction, not two assignments', () => {
    const parse = parseOwnerDraft('Plan @ana @ana:50', POOL);
    expect(parse.owners).toEqual([{ resourceId: 'r-ana', name: 'Ana Rivera', units: 50 }]);
  });

  it('collapses the whitespace a stripped token leaves behind', () => {
    expect(parseOwnerDraft('Draft @ana  plan', POOL).name).toBe('Draft plan');
  });

  it('returns the draft unchanged when the roster is empty', () => {
    const parse = parseOwnerDraft('Plan @ana', []);
    expect(parse.name).toBe('Plan @ana');
    expect(parse.owners).toEqual([]);
  });
});

describe('ownerTokensToApiPayload', () => {
  it('converts percent to the API fraction exactly once', () => {
    // TaskResource.units is a FRACTION (1.0 = 100%). A second conversion anywhere in
    // the client would silently halve or double every allocation.
    expect(ownerTokensToApiPayload([{ resourceId: 'r-ana', name: 'Ana', units: 50 }])).toEqual([
      { resource: 'r-ana', units: 0.5 },
    ]);
    expect(ownerTokensToApiPayload([{ resourceId: 'r-ben', name: 'Ben', units: 100 }])).toEqual([
      { resource: 'r-ben', units: 1 },
    ]);
  });
});

describe('activeOwnerQuery', () => {
  it('reports the fragment the caret sits inside', () => {
    expect(activeOwnerQuery('Draft plan @an')).toEqual({ query: 'an', start: 11, units: 100 });
  });

  it('carries an in-progress percent so picking from the list does not reset it', () => {
    expect(activeOwnerQuery('Draft @ana:25')?.units).toBe(25);
  });

  it('opens on a bare @ so the picker can list the whole roster', () => {
    expect(activeOwnerQuery('Draft @')?.query).toBe('');
  });

  it('does not open on an @ embedded in a word (an email address)', () => {
    expect(activeOwnerQuery('mail ana@example.com')).toBeNull();
  });

  it('closes once the author types a space', () => {
    expect(activeOwnerQuery('Draft @ana plan')).toBeNull();
  });

  it('is null when the draft has no @ at all', () => {
    expect(activeOwnerQuery('Draft plan')).toBeNull();
  });
});

describe('segmentUnresolvedOwners', () => {
  it('returns one plain segment when nothing is unresolved', () => {
    expect(segmentUnresolvedOwners('Draft plan', POOL)).toEqual([
      { text: 'Draft plan', unresolved: false },
    ]);
  });

  it('isolates the unresolved token from the surrounding text', () => {
    expect(segmentUnresolvedOwners('Plan @nobody now', POOL)).toEqual([
      { text: 'Plan ', unresolved: false },
      { text: '@nobody', unresolved: true },
      { text: ' now', unresolved: false },
    ]);
  });

  it('does not mark a token that resolves', () => {
    expect(segmentUnresolvedOwners('Plan @ana', POOL)).toEqual([
      { text: 'Plan @ana', unresolved: false },
    ]);
  });
});
