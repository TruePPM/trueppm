import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCurrentUserResourceId } from './useCurrentUserResourceId';
import type { ProjectResource } from '@/types';

vi.mock('./useProjectResourcePool', () => ({
  useProjectResourcePool: vi.fn(),
}));

import { useProjectResourcePool } from './useProjectResourcePool';
const useProjectResourcePoolMock = vi.mocked(useProjectResourcePool);

function pr(overrides: Partial<ProjectResource['resource']>, prId = 'pr-x'): ProjectResource {
  return {
    id: prId,
    projectId: 'p1',
    resourceId: overrides.id ?? 'r-x',
    resource: {
      id: overrides.id ?? 'r-x',
      name: overrides.name ?? 'Anon',
      email: overrides.email ?? '',
      jobRole: '',
      maxUnits: 1.0,
      calendarId: null,
      skills: [],
      isMe: overrides.isMe,
    },
    roleTitle: '',
    unitsOverride: null,
    effectiveMaxUnits: 1.0,
    notes: '',
  };
}

describe('useCurrentUserResourceId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the resourceId of the resource flagged is_me=true', () => {
    useProjectResourcePoolMock.mockReturnValue({
      data: [
        pr({ id: 'r-other', isMe: false }, 'pr-1'),
        pr({ id: 'r-me', isMe: true }, 'pr-2'),
      ],
      isLoading: false,
    } as ReturnType<typeof useProjectResourcePool>);
    const { result } = renderHook(() => useCurrentUserResourceId('p1'));
    expect(result.current.resourceId).toBe('r-me');
  });

  it('returns null when no resource is flagged is_me', () => {
    useProjectResourcePoolMock.mockReturnValue({
      data: [pr({ id: 'r-other', isMe: false }, 'pr-1')],
      isLoading: false,
    } as ReturnType<typeof useProjectResourcePool>);
    const { result } = renderHook(() => useCurrentUserResourceId('p1'));
    expect(result.current.resourceId).toBeNull();
  });

  it('returns null while pool is loading', () => {
    useProjectResourcePoolMock.mockReturnValue({
      data: undefined,
      isLoading: true,
    } as ReturnType<typeof useProjectResourcePool>);
    const { result } = renderHook(() => useCurrentUserResourceId('p1'));
    expect(result.current.resourceId).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });
});
