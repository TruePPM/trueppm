import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';
import { useBoardToolbarPrefs } from './useBoardToolbarPrefs';

describe('useBoardToolbarPrefs', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to rail layout and comfortable backlog density', () => {
    const { result } = renderHook(() => useBoardToolbarPrefs());
    expect(result.current.layout).toBe('rail');
    expect(result.current.backlogDensity).toBe('comfortable');
  });

  it('persists layout selection to localStorage', () => {
    const { result } = renderHook(() => useBoardToolbarPrefs());
    act(() => result.current.setLayout('drawer'));
    expect(result.current.layout).toBe('drawer');
    const stored = JSON.parse(
      localStorage.getItem('trueppm.board.toolbarPrefs.v1') ?? '{}',
    ) as { layout?: string; backlogDensity?: string };
    expect(stored.layout).toBe('drawer');
  });

  it('persists backlog density to localStorage', () => {
    const { result } = renderHook(() => useBoardToolbarPrefs());
    act(() => result.current.setBacklogDensity('full'));
    expect(result.current.backlogDensity).toBe('full');
    const stored = JSON.parse(
      localStorage.getItem('trueppm.board.toolbarPrefs.v1') ?? '{}',
    ) as { layout?: string; backlogDensity?: string };
    expect(stored.backlogDensity).toBe('full');
  });

  it('restores layout and density across reloads (acceptance criterion)', () => {
    localStorage.setItem(
      'trueppm.board.toolbarPrefs.v1',
      JSON.stringify({ layout: 'queue', backlogDensity: 'compact' }),
    );
    const { result } = renderHook(() => useBoardToolbarPrefs());
    expect(result.current.layout).toBe('queue');
    expect(result.current.backlogDensity).toBe('compact');
  });

  it('falls back to defaults on malformed JSON in localStorage', () => {
    localStorage.setItem('trueppm.board.toolbarPrefs.v1', '{not json');
    const { result } = renderHook(() => useBoardToolbarPrefs());
    expect(result.current.layout).toBe('rail');
    expect(result.current.backlogDensity).toBe('comfortable');
  });

  it('falls back to defaults on unknown enum values in stored prefs', () => {
    localStorage.setItem(
      'trueppm.board.toolbarPrefs.v1',
      JSON.stringify({ layout: 'mosaic', backlogDensity: 'jumbo' }),
    );
    const { result } = renderHook(() => useBoardToolbarPrefs());
    expect(result.current.layout).toBe('rail');
    expect(result.current.backlogDensity).toBe('comfortable');
  });
});
