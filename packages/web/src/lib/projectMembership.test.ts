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
});
