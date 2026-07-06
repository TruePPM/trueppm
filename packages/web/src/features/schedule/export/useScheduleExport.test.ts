import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useScheduleExport, type VisibleWindow } from './useScheduleExport';
import type { Task, TaskLink } from '@/types';

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    wbs: id,
    name: `Task ${id}`,
    start: '2026-04-01',
    finish: '2026-04-05',
    duration: 1,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
    ...overrides,
  } as Task;
}

// Task A is critical and early; Task B is non-critical and late.
const A = task('a', { wbs: '1', start: '2026-04-01', finish: '2026-04-08', isCritical: true });
const B = task('b', { wbs: '2', start: '2026-04-20', finish: '2026-04-30', isCritical: false });

function makeArgs(overrides: Partial<Parameters<typeof useScheduleExport>[0]> = {}) {
  return {
    projectName: 'Apollo',
    projectKey: null,
    workspaceUrl: null,
    userName: 'Jane',
    tasks: [A, B] as Task[],
    links: [] as TaskLink[],
    forecast: null,
    getVisibleWindow: (): VisibleWindow | null => ({ start: '2026-04-18', end: '2026-05-01' }),
    visibleWindowAvailable: true,
    ...overrides,
  };
}

describe('useScheduleExport', () => {
  it('canExport reflects task count and openDialog is a no-op when empty', () => {
    const { result } = renderHook(() => useScheduleExport(makeArgs({ tasks: [] })));
    expect(result.current.canExport).toBe(false);
    act(() => result.current.openDialog());
    expect(result.current.open).toBe(false);
  });

  it('openDialog opens the configuring state', () => {
    const { result } = renderHook(() => useScheduleExport(makeArgs()));
    act(() => result.current.openDialog());
    expect(result.current.open).toBe(true);
    expect(result.current.phase).toBe('configuring');
  });

  it('filteredCount defaults to critical-only, then reflects toggling non-critical on', () => {
    const { result } = renderHook(() => useScheduleExport(makeArgs()));
    act(() => result.current.openDialog());
    // Default includeNonCritical=false → only the critical row A is charted.
    expect(result.current.filteredCount).toBe(1);
    act(() => result.current.setOption('includeNonCritical', true));
    expect(result.current.filteredCount).toBe(2);
  });

  it('the visible-window range clips the charted rows to the snapshot window', () => {
    const { result } = renderHook(() => useScheduleExport(makeArgs()));
    act(() => result.current.openDialog());
    act(() => result.current.setOption('includeNonCritical', true));
    act(() => result.current.setOption('range', 'visible'));
    // Window 04-18..05-01 excludes A (Apr 1–8) and includes B (Apr 20–30).
    expect(result.current.filteredCount).toBe(1);
  });

  it('coerces range to full when the visible window is unavailable', () => {
    const { result } = renderHook(() =>
      useScheduleExport(makeArgs({ visibleWindowAvailable: false })),
    );
    act(() => {
      result.current.setOption('range', 'visible');
    });
    act(() => result.current.openDialog());
    expect(result.current.options.range).toBe('full');
  });

  it('startExport enters the generating state; closeDialog resets to configuring and closes', () => {
    const { result } = renderHook(() => useScheduleExport(makeArgs()));
    act(() => result.current.openDialog());
    act(() => result.current.startExport());
    expect(result.current.phase).toBe('generating');
    act(() => result.current.closeDialog());
    expect(result.current.open).toBe(false);
    expect(result.current.phase).toBe('configuring');
  });

  it('reset returns to configuring and clears any prior error/result', () => {
    const { result } = renderHook(() => useScheduleExport(makeArgs()));
    act(() => result.current.openDialog());
    act(() => result.current.reset());
    expect(result.current.phase).toBe('configuring');
    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('openInViewer opens the result blob URL in a new tab', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderHook(() => useScheduleExport(makeArgs()));
    // No result yet → openInViewer is a no-op.
    act(() => result.current.openInViewer());
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});
