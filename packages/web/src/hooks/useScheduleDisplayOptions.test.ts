import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  useScheduleDisplayOptions,
  DEFAULT_DISPLAY_OPTIONS,
} from './useScheduleDisplayOptions';

vi.mock('./useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { id: 'u1' }, isLoading: false }),
}));

const KEY = 'trueppm.schedule.displayOptions.u1.p1';

describe('useScheduleDisplayOptions', () => {
  beforeEach(() => window.localStorage.clear());

  it('defaults to the leaner reading — the panel disagreement resolved as a setting', () => {
    const { result } = renderHook(() => useScheduleDisplayOptions('p1'));
    expect(result.current.options).toEqual(DEFAULT_DISPLAY_OPTIONS);
    expect(result.current.options.structureButtons).toBe(false);
    expect(result.current.options.comfortableRows).toBe(false);
    // The coach is the one that starts ON — a user who never hovers a row would
    // otherwise never learn the row controls exist.
    expect(result.current.options.coach).toBe(true);
  });

  it('defaults Enter-creates-a-new-row ON, preserving #1666 (#3079)', () => {
    const { result } = renderHook(() => useScheduleDisplayOptions('p1'));
    // The one Outline option whose lean reading is ON: turning it off would change
    // shipped behavior for every user who never opens the Display menu.
    expect(result.current.options.enterCreatesRow).toBe(true);
  });

  it('persists Enter-creates-a-new-row like every other Outline option (#3079)', () => {
    const { result } = renderHook(() => useScheduleDisplayOptions('p1'));
    act(() => result.current.toggle('enterCreatesRow'));
    expect(result.current.options.enterCreatesRow).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toMatchObject({
      enterCreatesRow: false,
    });
  });

  it('rehydrates Enter-creates-a-new-row from storage (#3079)', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ enterCreatesRow: false }));
    const { result } = renderHook(() => useScheduleDisplayOptions('p1'));
    expect(result.current.options.enterCreatesRow).toBe(false);
  });

  it('persists a toggle per user per project', () => {
    const { result } = renderHook(() => useScheduleDisplayOptions('p1'));
    act(() => result.current.toggle('coach'));
    expect(result.current.options.coach).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toMatchObject({ coach: false });
  });

  it('rehydrates a dismissed coach — the restore path is the whole point', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ coach: false }));
    const { result } = renderHook(() => useScheduleDisplayOptions('p1'));
    expect(result.current.options.coach).toBe(false);
    // ...and it can come back, which the strip this replaces could never do.
    act(() => result.current.set('coach', true));
    expect(result.current.options.coach).toBe(true);
  });

  it('ignores a non-boolean stored value rather than rendering an undefined checkbox', () => {
    // A hand-edited or older-shape blob must not put a non-boolean into state.
    window.localStorage.setItem(KEY, JSON.stringify({ coach: 'yes', structureButtons: true }));
    const { result } = renderHook(() => useScheduleDisplayOptions('p1'));
    expect(result.current.options.coach).toBe(true); // fell back to the default
    expect(result.current.options.structureButtons).toBe(true);
  });

  it('survives unparseable storage', () => {
    window.localStorage.setItem(KEY, 'not json');
    const { result } = renderHook(() => useScheduleDisplayOptions('p1'));
    expect(result.current.options).toEqual(DEFAULT_DISPLAY_OPTIONS);
  });

  it('ships + Milestone unpinned for someone who has never set a preference (#3115)', () => {
    const { result } = renderHook(() => useScheduleDisplayOptions('p1'));
    expect(result.current.options.pinMilestone).toBe(false);
  });

  it('does not un-pin + Milestone for someone who already stored it pinned (#3115)', () => {
    // `writeStored` persists the WHOLE options object, so anyone who has ever
    // touched the Display menu has an explicit `pinMilestone` on disk. Flipping
    // the default must not reach back and take their button away — the new
    // default is for people who never expressed a preference, and `readStored`
    // merging key-by-key over the defaults is what keeps those two apart.
    window.localStorage.setItem(KEY, JSON.stringify({ ...DEFAULT_DISPLAY_OPTIONS, pinMilestone: true }));
    const { result } = renderHook(() => useScheduleDisplayOptions('p1'));
    expect(result.current.options.pinMilestone).toBe(true);
  });
});
