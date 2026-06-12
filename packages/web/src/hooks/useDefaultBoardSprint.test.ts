import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { resolveDefaultSprintId, useDefaultBoardSprint } from './useDefaultBoardSprint';
import type { ApiSprint, SprintState } from '@/types';

vi.mock('./useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { id: 'u-9' }, isLoading: false }),
}));

function sprint(id: string, state: SprintState): ApiSprint {
  return {
    id,
    name: id,
    state,
    start_date: '2026-06-01',
    finish_date: '2026-06-14',
  } as ApiSprint;
}

describe('resolveDefaultSprintId (#1141)', () => {
  it('auto-selects the single ACTIVE sprint when no stored choice', () => {
    const sprints = [sprint('a', 'ACTIVE'), sprint('p', 'PLANNED')];
    expect(resolveDefaultSprintId(sprints, null)).toBe('a');
  });

  it('falls back to Project view (null) when there is no ACTIVE sprint', () => {
    const sprints = [sprint('p', 'PLANNED'), sprint('d', 'COMPLETED')];
    expect(resolveDefaultSprintId(sprints, null)).toBeNull();
  });

  it('falls back to Project view (null) when there are MULTIPLE ACTIVE sprints', () => {
    const sprints = [sprint('a1', 'ACTIVE'), sprint('a2', 'ACTIVE')];
    expect(resolveDefaultSprintId(sprints, null)).toBeNull();
  });

  it('a stored choice wins over the single-ACTIVE auto rule', () => {
    const sprints = [sprint('a', 'ACTIVE'), sprint('p', 'PLANNED')];
    expect(resolveDefaultSprintId(sprints, 'p')).toBe('p');
  });

  it('ignores a stored choice that no longer maps to a live sprint', () => {
    const sprints = [sprint('a', 'ACTIVE')];
    // stored 'gone' was deleted -> fall through to single-ACTIVE.
    expect(resolveDefaultSprintId(sprints, 'gone')).toBe('a');
  });

  it('ignores a stored choice pointing at a CANCELLED sprint', () => {
    const sprints = [sprint('x', 'CANCELLED'), sprint('a', 'ACTIVE')];
    expect(resolveDefaultSprintId(sprints, 'x')).toBe('a');
  });
});

describe('useDefaultBoardSprint persistence (#1141)', () => {
  beforeEach(() => window.localStorage.clear());

  it('persists an explicit choice and restores it via resolveDefault', () => {
    const { result } = renderHook(() => useDefaultBoardSprint('p-1'));
    const sprints = [sprint('a', 'ACTIVE'), sprint('p', 'PLANNED')];

    // No stored choice yet -> auto single-ACTIVE.
    expect(result.current.resolveDefault(sprints)).toBe('a');

    // Persist an explicit override to the PLANNED sprint.
    result.current.persist('p-1', 'p');
    expect(window.localStorage.getItem('trueppm.boardSprint.u-9.p-1')).toBe('p');
    expect(result.current.resolveDefault(sprints)).toBe('p');

    // Clearing (Project view) removes the key and reverts to auto.
    result.current.persist('p-1', null);
    expect(window.localStorage.getItem('trueppm.boardSprint.u-9.p-1')).toBeNull();
    expect(result.current.resolveDefault(sprints)).toBe('a');
  });
});
