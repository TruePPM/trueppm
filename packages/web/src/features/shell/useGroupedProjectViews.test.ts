import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// The hook is a thin composition over the pure methodology/lens helpers plus four
// data hooks; mock the data hooks so we can assert the composition directly.
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: vi.fn(() => ({ role: 200, isLoading: false })), // SCHEDULER
}));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: vi.fn(() => ({ user: { hidden_views: [], role_context: 'unified' }, isLoading: false })),
}));
vi.mock('@/hooks/useProject', () => ({
  useProject: vi.fn(() => ({
    data: { id: 'p1', effective_methodology: 'HYBRID' },
    isLoading: false,
    error: null,
  })),
}));
vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: vi.fn(() => ({ singular: 'Sprint', plural: 'Sprints', lowerSingular: 'sprint' })),
}));

import { useGroupedProjectViews } from './useGroupedProjectViews';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useProject } from '@/hooks/useProject';

const mockUseRole = useCurrentUserRole as ReturnType<typeof vi.fn>;
const mockUseCurrentUser = useCurrentUser as ReturnType<typeof vi.fn>;
const mockUseProject = useProject as ReturnType<typeof vi.fn>;

/** Flatten every visible view key across all groups. */
function allViews(groups: { visibleViews: string[] }[]): string[] {
  return groups.flatMap((g) => g.visibleViews);
}

describe('useGroupedProjectViews', () => {
  it('includes the post-mockup TRACK views activity + assets on HYBRID (regression firewall)', () => {
    const { result } = renderHook(() => useGroupedProjectViews('p1'));
    const views = allViews(result.current.groups);
    // The view set has grown since the mockup — the hook yields activity (ADR-0201)
    // and assets (ADR-0215) automatically, so no presentation can silently drop them.
    expect(views).toContain('activity');
    expect(views).toContain('assets');
    // …and the full DELIVER trio + planning + people.
    expect(views).toEqual(expect.arrayContaining(['schedule', 'grid', 'product-backlog', 'sprints', 'board', 'resources']));
    // overview / settings are standalone, never inside a group.
    expect(views).not.toContain('overview');
    expect(views).not.toContain('settings');
    expect(result.current.standaloneLeading).toBe('overview');
    expect(result.current.standaloneTrailing).toBe('settings');
  });

  it('reads the SERVER-RESOLVED effective_methodology, not the raw override (rule 196)', () => {
    // Raw AGILE, but the server resolved WATERFALL (e.g. a workspace INHERIT lock).
    mockUseProject.mockReturnValueOnce({
      data: { id: 'p1', methodology: 'AGILE', effective_methodology: 'WATERFALL' },
      isLoading: false,
      error: null,
    });
    const { result } = renderHook(() => useGroupedProjectViews('p1'));
    expect(result.current.methodology).toBe('WATERFALL');
    const views = allViews(result.current.groups);
    // WATERFALL hides sprints/product-backlog and keeps schedule/calendar.
    expect(views).not.toContain('sprints');
    expect(views).not.toContain('product-backlog');
    expect(views).toEqual(expect.arrayContaining(['schedule', 'calendar', 'board']));
  });

  it('applies the per-user hidden_views on top of the methodology filter (ADR-0139)', () => {
    mockUseCurrentUser.mockReturnValueOnce({
      user: { hidden_views: ['schedule', 'calendar'], role_context: 'unified' },
      isLoading: false,
    });
    const { result } = renderHook(() => useGroupedProjectViews('p1'));
    const views = allViews(result.current.groups);
    expect(views).not.toContain('schedule');
    expect(views).not.toContain('calendar');
    expect(views).toContain('grid'); // a non-hidden PLAN view survives
  });

  it('gates the Team (resources) view behind Scheduler+ (pessimistic while loading)', () => {
    mockUseRole.mockReturnValueOnce({ role: 100, isLoading: false }); // MEMBER < SCHEDULER
    const { result } = renderHook(() => useGroupedProjectViews('p1'));
    expect(allViews(result.current.groups)).not.toContain('resources');
    // The PEOPLE group, now empty, is dropped entirely.
    expect(result.current.groups.some((g) => g.id === 'PEOPLE')).toBe(false);
  });

  it('labels the Sprints view with the configured iteration plural', () => {
    const { result } = renderHook(() => useGroupedProjectViews('p1'));
    expect(result.current.labelFor('sprints')).toBe('Sprints');
    expect(result.current.labelFor('activity')).toBe('Activity');
    expect(result.current.labelFor('assets')).toBe('Assets');
  });
});
