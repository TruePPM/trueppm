import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useInheritedCalendar } from './useInheritedCalendar';

const programsResult = { data: [] as unknown[], isLoading: false };
const workspaceResult = { data: undefined as { calendar: string | null } | undefined, isLoading: false };
const libraryResult = { data: [] as Array<{ id: string; name: string; working_days: number; hours_per_day: number }>, isLoading: false };

vi.mock('@/hooks/usePrograms', () => ({
  usePrograms: () => programsResult,
}));
vi.mock('@/features/settings/hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => workspaceResult,
}));
vi.mock('@/hooks/useProjectCalendars', () => ({
  useCalendarLibrary: () => libraryResult,
}));

describe('useInheritedCalendar (#2728, ADR-0441)', () => {
  beforeEach(() => {
    programsResult.data = [];
    programsResult.isLoading = false;
    workspaceResult.data = undefined;
    workspaceResult.isLoading = false;
    libraryResult.data = [];
    libraryResult.isLoading = false;
  });

  it('resolves the system default when nothing up the chain sets a calendar', () => {
    workspaceResult.data = { calendar: null };
    const { result } = renderHook(() => useInheritedCalendar(null));
    expect(result.current).toMatchObject({ id: null, source: 'system_default', loading: false });
    expect(result.current.name).toMatch(/system default/i);
  });

  it('resolves the workspace calendar by id when no program is selected', () => {
    workspaceResult.data = { calendar: 'cal-ws' };
    libraryResult.data = [
      { id: 'cal-ws', name: 'Standard 40h', working_days: 31, hours_per_day: 8 },
    ];
    const { result } = renderHook(() => useInheritedCalendar(null));
    expect(result.current).toMatchObject({ id: 'cal-ws', name: 'Standard 40h', source: 'workspace' });
  });

  it('prefers the selected program’s already-resolved effective_calendar over the workspace lookup', () => {
    programsResult.data = [
      {
        id: 'prog-1',
        effective_calendar: { id: 'cal-prog', name: 'Program Calendar', working_days: 31, hours_per_day: 6 },
        calendar_source: 'program',
      },
    ];
    workspaceResult.data = { calendar: 'cal-ws' };
    const { result } = renderHook(() => useInheritedCalendar('prog-1'));
    expect(result.current).toMatchObject({ id: 'cal-prog', name: 'Program Calendar', source: 'program' });
  });

  it('reports loading while the workspace/library queries are still in flight', () => {
    workspaceResult.isLoading = true;
    const { result } = renderHook(() => useInheritedCalendar(null));
    expect(result.current.loading).toBe(true);
  });

  it('falls back to the workspace/system resolution if the selected program id is not yet in the fetched list', () => {
    programsResult.data = [];
    workspaceResult.data = { calendar: null };
    const { result } = renderHook(() => useInheritedCalendar('prog-not-loaded-yet'));
    expect(result.current.source).toBe('system_default');
  });
});
