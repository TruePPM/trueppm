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
    // …and the full DELIVER trio + planning + the WORKSPACE scope band.
    expect(views).toEqual(
      expect.arrayContaining([
        'schedule',
        'grid',
        'product-backlog',
        'sprints',
        'board',
        'resources',
      ]),
    );
    // ADR-0942 retired the standalone leading/trailing views: `overview` and `settings`
    // are band members now, so there is no second place a presentation must remember to
    // look — which is the whole point of this hook (#1642).
    expect(views).toContain('overview');
    expect(views).toContain('settings');
    expect(result.current.groups.map((g) => g.id)).toEqual([
      'PLAN',
      'DELIVER',
      'TRACK',
      'WORKSPACE',
    ]);
    expect(result.current.groups.find((g) => g.id === 'WORKSPACE')?.visibleViews).toEqual([
      'resources',
      'settings',
    ]);
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
    // The WORKSPACE band survives on Settings alone — a scope band renders with both,
    // either, or neither member (ADR-0942 §2), and this is the reachable one-member case.
    expect(result.current.groups.find((g) => g.id === 'WORKSPACE')?.visibleViews).toEqual([
      'settings',
    ]);
  });

  it('gates the Settings view behind admin, and drops the WORKSPACE band when neither member survives', () => {
    // Both members gated away: a Member (no Scheduler) who also cannot reach project
    // Settings. The band must vanish entirely — no label, and for a scope band no rule
    // and no raised ground either (the empty-band rule, ADR-0942 §2).
    mockUseRole.mockReturnValueOnce({ role: 100, isLoading: false });
    mockUseCurrentUser.mockReturnValueOnce({
      user: { hidden_views: [], role_context: 'unified', can_access_admin_settings: false },
      isLoading: false,
    });
    const { result } = renderHook(() => useGroupedProjectViews('p1'));
    expect(result.current.groups.some((g) => g.id === 'WORKSPACE')).toBe(false);
    expect(allViews(result.current.groups)).not.toContain('settings');
  });

  it('keeps Settings visible while the admin signal is still loading (#2033)', () => {
    // Strict `!== false`: an undefined `can_access_admin_settings` must not flash-hide
    // the row for an admin whose /auth/me/ has not landed yet.
    mockUseCurrentUser.mockReturnValueOnce({
      user: { hidden_views: [], role_context: 'unified' },
      isLoading: true,
    });
    const { result } = renderHook(() => useGroupedProjectViews('p1'));
    expect(allViews(result.current.groups)).toContain('settings');
  });

  it('never lets the personal hidden-set empty the rail (ADR-0942 §6)', () => {
    // Every hideable key hidden at once. Dashboard and Settings remain because they are
    // always-on, not because they sit outside the bands — they no longer do.
    mockUseCurrentUser.mockReturnValueOnce({
      user: {
        hidden_views: [
          'schedule',
          'grid',
          'calendar',
          'product-backlog',
          'sprints',
          'board',
          'today',
          'risk',
          'reports',
          'activity',
          'assets',
          'resources',
        ],
        role_context: 'unified',
      },
      isLoading: false,
    });
    const { result } = renderHook(() => useGroupedProjectViews('p1'));
    expect(allViews(result.current.groups)).toEqual(['overview', 'settings']);
  });

  it('labels the Sprints view with the configured iteration plural', () => {
    const { result } = renderHook(() => useGroupedProjectViews('p1'));
    expect(result.current.labelFor('sprints')).toBe('Sprints');
    expect(result.current.labelFor('activity')).toBe('Activity');
    expect(result.current.labelFor('assets')).toBe('Assets');
  });

  it('gives Schedule exactly one home — the placement opt-in is retired (#3137)', () => {
    // ADR-0942 §3: a nav item listed twice is two objects to the person using it. The
    // `schedule_in_deliver` opt-in (ADR-0203, #1645) that echoed Schedule into DELIVER
    // while keeping it in PLAN is gone, field and all — a stale profile carrying the key
    // must change nothing.
    mockUseCurrentUser.mockReturnValueOnce({
      user: { hidden_views: [], role_context: 'unified', schedule_in_deliver: true },
      isLoading: false,
    });
    const { result } = renderHook(() => useGroupedProjectViews('p1'));
    const bandsWithSchedule = result.current.groups
      .filter((g) => g.visibleViews.includes('schedule'))
      .map((g) => g.id);
    expect(bandsWithSchedule).toEqual(['PLAN']);
    expect(result.current.groups.find((g) => g.id === 'DELIVER')?.visibleViews).toEqual([
      'product-backlog',
      'sprints',
      'board',
    ]);
  });
});
