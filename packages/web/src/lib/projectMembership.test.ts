import { describe, expect, it } from 'vitest';

import { isMemberProject } from './projectMembership';

describe('isMemberProject (ADR-1434)', () => {
  it('is false only for an explicit null role', () => {
    expect(isMemberProject({ myRole: null })).toBe(false);
  });

  it('is true for any held role', () => {
    expect(isMemberProject({ myRole: 1 })).toBe(true);
    expect(isMemberProject({ myRole: 400 })).toBe(true);
  });

  it('treats an absent role as a member (pre-ADR-1434 shape)', () => {
    expect(isMemberProject({})).toBe(true);
  });

  // MyWorkPage derives `memberProjects` with `(listedProjects ?? []).filter(isMemberProject)`
  // and gates the "reachable only via a program" empty state on its length. There is no
  // MyWorkPage component test, so the expression is pinned here on a list that holds a
  // WORKSPACE-visible non-member row.
  it('filters a listed set down to member rows for My Work', () => {
    const listed = [
      { id: 'a', myRole: 400 },
      { id: 'b', myRole: null },
      { id: 'c', myRole: 100 },
    ];
    expect(listed.filter(isMemberProject).map((p) => p.id)).toEqual(['a', 'c']);
    expect([{ id: 'b', myRole: null }].filter(isMemberProject)).toHaveLength(0);
  });
});
