/**
 * `useBoardSprintScope` — the sprint write-lock must not fail open on load
 * timing (#3424, the #3313 class).
 *
 * `useSprints` returns `[]` while loading AND after a failure, so a `?sprint=`
 * board on a cold mount resolved `selectedSprint` to null and `sprintClosed`
 * to false — fully editable, no banner — until the list landed. The hook now
 * reports `sprintStateUnknown` for that window, and the two flags carry the
 * two polarities rule 379 requires: the lock (a withheld affordance) engages
 * on unknown; the closed banner (a disclosure) stays silent until known.
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSprint } from '@/types';
import { useBoardSprintScope } from './useBoardSprintScope';

let mockSprints: ApiSprint[] = [];
let mockLoading = false;
let mockError: Error | null = null;

vi.mock('@/hooks/useSprints', () => ({
  useSprints: () => ({
    sprints: mockSprints,
    totalCount: mockSprints.length,
    isLoading: mockLoading,
    error: mockError,
  }),
}));

vi.mock('@/hooks/useDefaultBoardSprint', () => ({
  useDefaultBoardSprint: () => ({
    isLoading: false,
    resolveDefault: () => null,
    persist: vi.fn(),
  }),
}));

function sprint(id: string, state: ApiSprint['state']): ApiSprint {
  return { id, name: `Sprint ${id}`, state } as ApiSprint;
}

function scope(params: string) {
  const setSearchParams = vi.fn();
  return renderHook(() =>
    useBoardSprintScope('project-1', new URLSearchParams(params), setSearchParams),
  ).result.current;
}

describe('useBoardSprintScope — sprint write-lock vs unresolved sprints (#3424)', () => {
  beforeEach(() => {
    mockSprints = [];
    mockLoading = false;
    mockError = null;
  });

  it('LOADING with ?sprint=: the state is unknown and the sprint is NOT reported closed', () => {
    mockLoading = true;
    const s = scope('sprint=sp-done');
    expect(s.sprintStateUnknown).toBe(true);
    expect(s.sprintClosed).toBe(false);
    expect(s.selectedSprint).toBeNull();
  });

  it('FAILED with ?sprint= and nothing cached: the state is unknown, not open', () => {
    mockError = new Error('503');
    const s = scope('sprint=sp-done');
    expect(s.sprintStateUnknown).toBe(true);
    expect(s.sprintClosed).toBe(false);
  });

  it('resolved COMPLETED: closed is positively known and unknown clears', () => {
    mockSprints = [sprint('sp-done', 'COMPLETED')];
    const s = scope('sprint=sp-done');
    expect(s.sprintClosed).toBe(true);
    expect(s.sprintStateUnknown).toBe(false);
  });

  it('resolved ACTIVE: neither closed nor unknown — the board is editable', () => {
    mockSprints = [sprint('sp-live', 'ACTIVE')];
    const s = scope('sprint=sp-live');
    expect(s.sprintClosed).toBe(false);
    expect(s.sprintStateUnknown).toBe(false);
  });

  it('a refetch failure that kept the last good list still answers — not unknown', () => {
    mockSprints = [sprint('sp-done', 'COMPLETED')];
    mockError = new Error('refetch failed');
    const s = scope('sprint=sp-done');
    expect(s.sprintClosed).toBe(true);
    expect(s.sprintStateUnknown).toBe(false);
  });

  it('Project view (no ?sprint=) is never unknown, even while the list loads', () => {
    mockLoading = true;
    const s = scope('');
    expect(s.sprintStateUnknown).toBe(false);
    expect(s.sprintClosed).toBe(false);
  });

  it('a resolved list that lacks the id is "not closed", not "unknown"', () => {
    // The sprint may simply be off the first page; that gap is not a timing
    // race and is deliberately not folded into the lock here.
    mockSprints = [sprint('sp-other', 'ACTIVE')];
    const s = scope('sprint=sp-missing');
    expect(s.sprintStateUnknown).toBe(false);
    expect(s.sprintClosed).toBe(false);
  });
});
