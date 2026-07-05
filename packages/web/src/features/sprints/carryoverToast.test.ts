import { describe, it, expect } from 'vitest';
import { buildCarryoverToast, carryoverAdvanceTarget } from './carryoverToast';

describe('buildCarryoverToast (#1470)', () => {
  it('names the destination sprint when carrying to a real sprint', () => {
    expect(buildCarryoverToast('Sprint 7', 3, 'dest-uuid', 'Sprint 8')).toBe(
      'Sprint 7 closed — 3 tasks carried to Sprint 8.',
    );
  });

  it('singularizes the task noun for a single carried task', () => {
    expect(buildCarryoverToast('Sprint 7', 1, 'dest-uuid', 'Sprint 8')).toBe(
      'Sprint 7 closed — 1 task carried to Sprint 8.',
    );
  });

  it('says "the backlog" for a backlog carry', () => {
    expect(buildCarryoverToast('Sprint 7', 2, 'backlog', null)).toBe(
      'Sprint 7 closed — 2 tasks moved to the backlog.',
    );
  });

  it('falls back to a plain close for the "leave on this sprint" choice', () => {
    // 'none' moves nothing — the copy must not imply a carry even if the count
    // (which the caller passes regardless) is non-zero.
    expect(buildCarryoverToast('Sprint 7', 4, 'none', null)).toBe('Sprint 7 closed.');
  });

  it('falls back to a plain close when nothing was eligible to carry', () => {
    // Empty case: destination is a real sprint but 0 tasks qualified. Do not
    // claim "0 tasks carried" — the estimate is honest about "nothing moved".
    expect(buildCarryoverToast('Sprint 7', 0, 'dest-uuid', 'Sprint 8')).toBe(
      'Sprint 7 closed.',
    );
    expect(buildCarryoverToast('Sprint 7', 0, 'backlog', null)).toBe('Sprint 7 closed.');
  });

  it('degrades to a plain close if the destination name is missing', () => {
    // A real sprint id but no resolved name (e.g. planned sprint not yet loaded)
    // must not render "carried to null".
    expect(buildCarryoverToast('Sprint 7', 2, 'dest-uuid', null)).toBe('Sprint 7 closed.');
  });
});

describe('carryoverAdvanceTarget (#1470)', () => {
  it('advances to a real destination sprint', () => {
    expect(carryoverAdvanceTarget('dest-uuid')).toBe('dest-uuid');
  });

  it('does not advance for a backlog carry (no destination tab)', () => {
    expect(carryoverAdvanceTarget('backlog')).toBeNull();
  });

  it('does not advance for the "leave on this sprint" choice', () => {
    expect(carryoverAdvanceTarget('none')).toBeNull();
  });
});
