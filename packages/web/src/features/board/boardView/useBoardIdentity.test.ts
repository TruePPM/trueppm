/**
 * `boardReadOnly` unit tests (#2680).
 *
 * The board-wide read-only flag drives every write-affordance guard on the
 * board (BoardCard drag, BacklogCard drag, quick-capture, handleMenuMove) —
 * getting its role/sprint matrix right in one place is what keeps those
 * guards from drifting apart. Covers the three cases #2680 asked for
 * explicitly: a Viewer, a Member on a closed sprint, and an otherwise
 * allowed role — plus the Admin-on-closed-sprint case, since the whole point
 * of `sprintClosed` is that it freezes the board regardless of role.
 *
 * #3424 adds the third input, `sprintStateUnknown`: a `?sprint=` board whose
 * sprints query has not resolved (or failed) locks like a closed sprint,
 * because the lock cannot rule out the one thing it exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import { boardReadOnly } from './useBoardIdentity';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_VIEWER } from '@/lib/roles';

describe('boardReadOnly (#2680)', () => {
  it('is read-only for a Viewer even on an open (non-closed) sprint', () => {
    expect(boardReadOnly(ROLE_VIEWER, false, false)).toBe(true);
  });

  it('is read-only for a Member on a closed sprint', () => {
    expect(boardReadOnly(ROLE_MEMBER, true, false)).toBe(true);
  });

  it('is read-only for an Admin on a closed sprint — sprintClosed overrides role', () => {
    expect(boardReadOnly(ROLE_ADMIN, true, false)).toBe(true);
  });

  it('is NOT read-only for an allowed role (Member) on an open sprint', () => {
    expect(boardReadOnly(ROLE_MEMBER, false, false)).toBe(false);
  });

  it('is NOT read-only for Admin on an open sprint', () => {
    expect(boardReadOnly(ROLE_ADMIN, false, false)).toBe(false);
  });

  it('is read-only while the role has not loaded yet (null, pessimistic default)', () => {
    expect(boardReadOnly(null, false, false)).toBe(true);
  });
});

describe('boardReadOnly — unresolved sprint state (#3424)', () => {
  it('is read-only for a Member while the scoped sprint\'s state is unknown', () => {
    expect(boardReadOnly(ROLE_MEMBER, false, true)).toBe(true);
  });

  it('is read-only for an Admin while the scoped sprint\'s state is unknown — same as closed', () => {
    expect(boardReadOnly(ROLE_ADMIN, false, true)).toBe(true);
    expect(boardReadOnly(ROLE_ADMIN, false, true)).toBe(boardReadOnly(ROLE_ADMIN, true, false));
  });

  it('unlocks the moment the sprint is known open', () => {
    expect(boardReadOnly(ROLE_MEMBER, false, false)).toBe(false);
  });
});
