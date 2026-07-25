import { describe, expect, it } from 'vitest';
import {
  countTasksByOwner,
  groupOwnerCandidates,
  ownerDisplayName,
  taskMatchesOwners,
} from './ownerFilter';

const alice = { resourceId: 'r1', name: 'A. Reyes', units: 1 };
const osei = { resourceId: 'r2', name: 'M. Osei', units: 1 };

const ROSTER = [
  { id: 'r1', name: 'A. Reyes' },
  { id: 'r2', name: 'M. Osei' },
  { id: 'r3', name: 'J. Park' },
  { id: 'r4', name: 'B. Chen' },
];

describe('taskMatchesOwners', () => {
  it('matches everything when nothing is selected', () => {
    expect(taskMatchesOwners({ assignees: [] }, [])).toBe(true);
  });

  it('ORs within the facet — any selected owner is enough', () => {
    const task = { assignees: [osei] };
    expect(taskMatchesOwners(task, ['r1', 'r2'])).toBe(true);
  });

  it('excludes a task assigned to nobody once an owner is selected', () => {
    expect(taskMatchesOwners({ assignees: [] }, ['r1'])).toBe(false);
    expect(taskMatchesOwners({}, ['r1'])).toBe(false);
  });

  it('matches on resource id', () => {
    expect(taskMatchesOwners({ assignees: [alice] }, ['r1'])).toBe(true);
    expect(taskMatchesOwners({ assignees: [alice] }, ['r9'])).toBe(false);
  });

  it('also matches on name, so a pre-#2387 ?owner=<name> link still resolves', () => {
    // `?owner=` shipped as a name match. New links are id-based (a rename must
    // not break a shared URL), but the old ones are still out there.
    expect(taskMatchesOwners({ assignees: [alice] }, ['A. Reyes'])).toBe(true);
  });
});

describe('countTasksByOwner', () => {
  const tasks = [
    { assignees: [alice] },
    { assignees: [alice, osei] },
    { assignees: [] },
  ];

  it('counts a task once per assignee — both options would keep it', () => {
    const counts = countTasksByOwner(tasks, ['r1', 'r2']);
    expect(counts).toEqual({ r1: 2, r2: 1 });
  });

  it('seeds every roster member at 0 so a person with no rows still renders', () => {
    const counts = countTasksByOwner(tasks, ['r1', 'r4']);
    expect(counts.r4).toBe(0);
  });

  it('ignores assignees who are not in the roster', () => {
    const counts = countTasksByOwner(tasks, ['r4']);
    expect(counts).toEqual({ r4: 0 });
  });
});

describe('groupOwnerCandidates', () => {
  it('splits into people with rows and everyone else', () => {
    const counts = { r1: 12, r2: 34, r3: 0, r4: 0 };
    const { onTheseRows, allMembers } = groupOwnerCandidates(ROSTER, counts);
    expect(onTheseRows.map((c) => c.name)).toEqual(['M. Osei', 'A. Reyes']);
    expect(allMembers.map((c) => c.name)).toEqual(['B. Chen', 'J. Park']);
  });

  it('orders "on these rows" by count, ties by name, so the list never reshuffles', () => {
    const counts = { r1: 5, r2: 5, r3: 9, r4: 0 };
    const { onTheseRows } = groupOwnerCandidates(ROSTER, counts);
    expect(onTheseRows.map((c) => c.name)).toEqual(['J. Park', 'A. Reyes', 'M. Osei']);
  });

  it('treats a member missing from the counts map as zero', () => {
    const { allMembers } = groupOwnerCandidates(ROSTER, {});
    expect(allMembers).toHaveLength(4);
  });
});

describe('ownerDisplayName', () => {
  it('resolves an id to its roster name', () => {
    expect(ownerDisplayName('r3', ROSTER)).toBe('J. Park');
  });

  it('falls back to the raw value for an owner no longer on the project', () => {
    // The filter is still applied, so rendering nothing would be a lie.
    expect(ownerDisplayName('r-gone', ROSTER)).toBe('r-gone');
  });
});
