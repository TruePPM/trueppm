import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useSettingsSaveStore } from './useSettingsSaveStore';

function reset() {
  useSettingsSaveStore.getState().reset();
}

describe('useSettingsSaveStore', () => {
  beforeEach(reset);

  it('starts in clean idle state', () => {
    const state = useSettingsSaveStore.getState();
    expect(state.dirty).toBe(false);
    expect(state.apiReady).toBe(false);
    expect(state.isSaving).toBe(false);
    expect(state.saveError).toBeNull();
    expect(state.onSave).toBeNull();
    expect(state.onReset).toBeNull();
  });

  it('register publishes dirty + handlers', () => {
    const onSave = vi.fn();
    const onReset = vi.fn();
    useSettingsSaveStore.getState().register({
      dirty: true,
      apiReady: true,
      onSave,
      onReset,
    });
    const state = useSettingsSaveStore.getState();
    expect(state.dirty).toBe(true);
    expect(state.apiReady).toBe(true);
    expect(state.onSave).toBe(onSave);
    expect(state.onReset).toBe(onReset);
  });

  it('reset returns to idle state', () => {
    useSettingsSaveStore.getState().register({
      dirty: true,
      apiReady: true,
      onSave: vi.fn(),
      onReset: vi.fn(),
    });
    reset();
    expect(useSettingsSaveStore.getState().dirty).toBe(false);
    expect(useSettingsSaveStore.getState().onSave).toBeNull();
  });

  it('triggerSave runs onSave and toggles isSaving', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    useSettingsSaveStore.getState().register({
      dirty: true,
      apiReady: true,
      onSave,
      onReset: vi.fn(),
    });
    const savePromise = useSettingsSaveStore.getState().triggerSave();
    expect(useSettingsSaveStore.getState().isSaving).toBe(true);
    await savePromise;
    expect(useSettingsSaveStore.getState().isSaving).toBe(false);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('triggerSave surfaces error message on rejection', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('boom'));
    useSettingsSaveStore.getState().register({
      dirty: true,
      apiReady: true,
      onSave,
      onReset: vi.fn(),
    });
    await useSettingsSaveStore.getState().triggerSave();
    expect(useSettingsSaveStore.getState().saveError).toBe('boom');
    expect(useSettingsSaveStore.getState().isSaving).toBe(false);
  });

  it('triggerSave is a noop when no onSave registered', async () => {
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
    useSettingsSaveStore.getState().register({
      dirty: true,
      apiReady: true,
      onSave,
      onReset: vi.fn(),
    });
    const first = useSettingsSaveStore.getState().triggerSave();
    // Second invocation while first is in flight should not call onSave again.
    void useSettingsSaveStore.getState().triggerSave();
    expect(onSave).toHaveBeenCalledTimes(1);
    resolveSave();
    await first;
  });

  it('triggerDiscard calls onReset', () => {
    const onReset = vi.fn();
    useSettingsSaveStore.getState().register({
      dirty: true,
      apiReady: true,
      onSave: vi.fn(),
      onReset,
    });
    useSettingsSaveStore.getState().triggerDiscard();
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('triggerDiscard does not reset while saving', () => {
    const onReset = vi.fn();
    useSettingsSaveStore.setState({ isSaving: true, onReset });
    useSettingsSaveStore.getState().triggerDiscard();
    expect(onReset).not.toHaveBeenCalled();
  });

  it('clearError wipes saveError', () => {
    useSettingsSaveStore.setState({ saveError: 'something' });
    useSettingsSaveStore.getState().clearError();
    expect(useSettingsSaveStore.getState().saveError).toBeNull();
  });

  it('register with dirty=false clears a stale saveError', () => {
    useSettingsSaveStore.setState({ saveError: 'previous' });
    useSettingsSaveStore.getState().register({
      dirty: false,
      apiReady: true,
      onSave: vi.fn(),
      onReset: vi.fn(),
    });
    expect(useSettingsSaveStore.getState().saveError).toBeNull();
  });
});
