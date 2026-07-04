import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDirtyDraft } from './useDirtyDraft';

interface Draft {
  name: string;
  points: number | null;
}

describe('useDirtyDraft', () => {
  it('starts clean and mirrors the initial value in both draft and baseline', () => {
    const { result } = renderHook(() => useDirtyDraft<Draft>({ name: 'Alpha', points: 3 }));
    expect(result.current.dirty).toBe(false);
    expect(result.current.draft).toEqual({ name: 'Alpha', points: 3 });
    expect(result.current.baseline).toEqual({ name: 'Alpha', points: 3 });
  });

  it('goes dirty when a field changes and clean again when it returns to baseline', () => {
    const { result } = renderHook(() => useDirtyDraft<Draft>({ name: 'Alpha', points: 3 }));

    act(() => result.current.setField('name', 'Beta'));
    expect(result.current.dirty).toBe(true);
    expect(result.current.draft.name).toBe('Beta');

    // Typing the original value back clears dirty (structural, not identity, compare).
    act(() => result.current.setField('name', 'Alpha'));
    expect(result.current.dirty).toBe(false);
  });

  it('reset() reverts the draft to the baseline (Cancel)', () => {
    const { result } = renderHook(() => useDirtyDraft<Draft>({ name: 'Alpha', points: 3 }));

    act(() => result.current.setField('points', 8));
    expect(result.current.dirty).toBe(true);

    act(() => result.current.reset());
    expect(result.current.draft).toEqual({ name: 'Alpha', points: 3 });
    expect(result.current.dirty).toBe(false);
  });

  it('commit() adopts the current draft as the new baseline (post-save)', () => {
    const { result } = renderHook(() => useDirtyDraft<Draft>({ name: 'Alpha', points: 3 }));

    act(() => result.current.setField('name', 'Gamma'));
    act(() => result.current.commit());

    expect(result.current.dirty).toBe(false);
    expect(result.current.baseline.name).toBe('Gamma');
    // A subsequent edit is dirty again relative to the new baseline.
    act(() => result.current.setField('name', 'Delta'));
    expect(result.current.dirty).toBe(true);
  });

  it('commit(next) adopts an explicit value as the baseline and draft', () => {
    const { result } = renderHook(() => useDirtyDraft<Draft>({ name: 'Alpha', points: 3 }));

    act(() => result.current.commit({ name: 'Server', points: 13 }));
    expect(result.current.draft).toEqual({ name: 'Server', points: 13 });
    expect(result.current.dirty).toBe(false);
  });

  it('does not auto-resync when the initial argument changes (no clobber of an edit)', () => {
    const { result, rerender } = renderHook(
      ({ init }: { init: Draft }) => useDirtyDraft<Draft>(init),
      { initialProps: { init: { name: 'Alpha', points: 3 } } },
    );

    act(() => result.current.setField('name', 'Editing…'));
    // A concurrent server update arrives as a new initial prop — must NOT clobber.
    rerender({ init: { name: 'ServerRenamed', points: 3 } });

    expect(result.current.draft.name).toBe('Editing…');
    expect(result.current.dirty).toBe(true);
  });
});
