import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useSettingsSaveStore } from './useSettingsSaveStore';

function reset() {
  useSettingsSaveStore.getState().reset();
}

const SEC = 'general';

function register(
  sectionId: string,
  opts: Partial<{
    dirty: boolean;
    apiReady: boolean;
    onSave: () => Promise<void> | void;
    onReset: () => void;
  }> = {},
) {
  useSettingsSaveStore.getState().register(sectionId, {
    dirty: opts.dirty ?? true,
    apiReady: opts.apiReady ?? true,
    onSave: opts.onSave ?? vi.fn(),
    onReset: opts.onReset ?? vi.fn(),
  });
}

describe('useSettingsSaveStore', () => {
  beforeEach(reset);

  it('starts in clean idle state', () => {
    const state = useSettingsSaveStore.getState();
    expect(state.dirty).toBe(false);
    expect(state.apiReady).toBe(false);
    expect(state.isSaving).toBe(false);
    expect(state.saveError).toBeNull();
    expect(state.lastSavedAt).toBeNull();
    expect(state.sections).toEqual({});
  });

  it('register publishes aggregate dirty + apiReady', () => {
    register(SEC, { dirty: true, apiReady: true });
    const state = useSettingsSaveStore.getState();
    expect(state.dirty).toBe(true);
    expect(state.apiReady).toBe(true);
    expect(state.sections[SEC]).toBeDefined();
  });

  it('reset returns to idle state', () => {
    register(SEC);
    reset();
    expect(useSettingsSaveStore.getState().dirty).toBe(false);
    expect(useSettingsSaveStore.getState().sections).toEqual({});
  });

  it('triggerSave runs onSave and toggles isSaving', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    register(SEC, { onSave });
    const savePromise = useSettingsSaveStore.getState().triggerSave();
    expect(useSettingsSaveStore.getState().isSaving).toBe(true);
    await savePromise;
    expect(useSettingsSaveStore.getState().isSaving).toBe(false);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('triggerSave surfaces error message on rejection', async () => {
    register(SEC, { onSave: vi.fn().mockRejectedValue(new Error('boom')) });
    await useSettingsSaveStore.getState().triggerSave();
    expect(useSettingsSaveStore.getState().saveError).toBe('boom');
    expect(useSettingsSaveStore.getState().isSaving).toBe(false);
  });

  it('triggerSave is a noop when nothing is registered', async () => {
    await useSettingsSaveStore.getState().triggerSave();
    expect(useSettingsSaveStore.getState().isSaving).toBe(false);
    expect(useSettingsSaveStore.getState().saveError).toBeNull();
  });

  it('triggerSave is a noop while already saving', async () => {
    let resolveSave!: () => void;
    const onSave = vi.fn().mockReturnValue(
      new Promise<void>((r) => {
        resolveSave = r;
      }),
    );
    register(SEC, { onSave });
    const first = useSettingsSaveStore.getState().triggerSave();
    void useSettingsSaveStore.getState().triggerSave();
    expect(onSave).toHaveBeenCalledTimes(1);
    resolveSave();
    await first;
  });

  it('triggerDiscard calls onReset for the dirty section', () => {
    const onReset = vi.fn();
    register(SEC, { onReset });
    useSettingsSaveStore.getState().triggerDiscard();
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('triggerDiscard does not reset while saving', () => {
    const onReset = vi.fn();
    register(SEC, { dirty: true, onReset });
    useSettingsSaveStore.setState({ isSaving: true });
    useSettingsSaveStore.getState().triggerDiscard();
    expect(onReset).not.toHaveBeenCalled();
  });

  it('clearError wipes saveError', () => {
    useSettingsSaveStore.setState({ saveError: 'something' });
    useSettingsSaveStore.getState().clearError();
    expect(useSettingsSaveStore.getState().saveError).toBeNull();
  });

  it('triggerSave stamps lastSavedAt on success', async () => {
    const before = Date.now();
    register(SEC, { onSave: vi.fn().mockResolvedValue(undefined) });
    await useSettingsSaveStore.getState().triggerSave();
    const after = Date.now();
    const stamped = useSettingsSaveStore.getState().lastSavedAt;
    expect(stamped).not.toBeNull();
    expect(stamped!).toBeGreaterThanOrEqual(before);
    expect(stamped!).toBeLessThanOrEqual(after);
  });

  it('triggerSave does not stamp lastSavedAt on failure', async () => {
    register(SEC, { onSave: vi.fn().mockRejectedValue(new Error('boom')) });
    await useSettingsSaveStore.getState().triggerSave();
    expect(useSettingsSaveStore.getState().lastSavedAt).toBeNull();
  });

  it('reset clears lastSavedAt', () => {
    useSettingsSaveStore.setState({ lastSavedAt: 12345 });
    reset();
    expect(useSettingsSaveStore.getState().lastSavedAt).toBeNull();
  });

  it('register preserves lastSavedAt (so saved footer survives re-registration)', () => {
    useSettingsSaveStore.setState({ lastSavedAt: 12345 });
    register(SEC, { dirty: false });
    expect(useSettingsSaveStore.getState().lastSavedAt).toBe(12345);
  });

  it('register with dirty=false clears a stale saveError', () => {
    useSettingsSaveStore.setState({ saveError: 'previous' });
    register(SEC, { dirty: false });
    expect(useSettingsSaveStore.getState().saveError).toBeNull();
  });

  // ── ADR-0146: multi-section registry (#1248) ──────────────────────────────

  it('aggregates dirty across multiple sections', () => {
    register('a', { dirty: false });
    register('b', { dirty: false });
    expect(useSettingsSaveStore.getState().dirty).toBe(false);
    register('b', { dirty: true });
    expect(useSettingsSaveStore.getState().dirty).toBe(true);
  });

  it('unregister removes only its own section and recomputes dirty', () => {
    register('a', { dirty: true });
    register('b', { dirty: false });
    expect(useSettingsSaveStore.getState().dirty).toBe(true);
    useSettingsSaveStore.getState().unregister('a');
    expect(useSettingsSaveStore.getState().sections.a).toBeUndefined();
    expect(useSettingsSaveStore.getState().sections.b).toBeDefined();
    expect(useSettingsSaveStore.getState().dirty).toBe(false);
  });

  it('triggerSave saves every dirty section but skips clean ones', async () => {
    const saveA = vi.fn().mockResolvedValue(undefined);
    const saveB = vi.fn().mockResolvedValue(undefined);
    const saveClean = vi.fn().mockResolvedValue(undefined);
    register('a', { dirty: true, onSave: saveA });
    register('b', { dirty: true, onSave: saveB });
    register('clean', { dirty: false, onSave: saveClean });
    await useSettingsSaveStore.getState().triggerSave();
    expect(saveA).toHaveBeenCalledTimes(1);
    expect(saveB).toHaveBeenCalledTimes(1);
    expect(saveClean).not.toHaveBeenCalled();
  });

  it('triggerSave stops on the first failing section and surfaces its message', async () => {
    const saveA = vi.fn().mockRejectedValue(new Error('a failed'));
    const saveB = vi.fn().mockResolvedValue(undefined);
    register('a', { dirty: true, onSave: saveA });
    register('b', { dirty: true, onSave: saveB });
    await useSettingsSaveStore.getState().triggerSave();
    expect(useSettingsSaveStore.getState().saveError).toBe('a failed');
    // Sequential: the failing section short-circuits the run.
    expect(saveB).not.toHaveBeenCalled();
  });

  it('triggerDiscard resets only the dirty sections', () => {
    const resetA = vi.fn();
    const resetClean = vi.fn();
    register('a', { dirty: true, onReset: resetA });
    register('clean', { dirty: false, onReset: resetClean });
    useSettingsSaveStore.getState().triggerDiscard();
    expect(resetA).toHaveBeenCalledTimes(1);
    expect(resetClean).not.toHaveBeenCalled();
  });
});
