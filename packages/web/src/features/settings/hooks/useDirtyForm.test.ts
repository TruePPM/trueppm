import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useDirtyForm } from './useDirtyForm';
import { useSettingsSaveStore } from './useSettingsSaveStore';

function reset() {
  useSettingsSaveStore.getState().reset();
}

describe('useDirtyForm', () => {
  beforeEach(reset);

  it('publishes dirty=false when values match initialValues', () => {
    renderHook(() =>
      useDirtyForm({
        values: { name: 'A' },
        initialValues: { name: 'A' },
        onSave: vi.fn(),
        onReset: vi.fn(),
        apiReady: true,
      }),
    );
    expect(useSettingsSaveStore.getState().dirty).toBe(false);
  });

  it('publishes dirty=true when values differ from initialValues', () => {
    renderHook(() =>
      useDirtyForm({
        values: { name: 'B' },
        initialValues: { name: 'A' },
        onSave: vi.fn(),
        onReset: vi.fn(),
        apiReady: true,
      }),
    );
    expect(useSettingsSaveStore.getState().dirty).toBe(true);
  });

  it('forces dirty=false when apiReady is false even if values differ', () => {
    renderHook(() =>
      useDirtyForm({
        values: { name: 'B' },
        initialValues: { name: 'A' },
        onSave: vi.fn(),
        onReset: vi.fn(),
        apiReady: false,
      }),
    );
    expect(useSettingsSaveStore.getState().dirty).toBe(false);
  });

  it('flips dirty as values change between renders', () => {
    const { rerender } = renderHook(
      ({ values }: { values: { name: string } }) =>
        useDirtyForm({
          values,
          initialValues: { name: 'A' },
          onSave: vi.fn(),
          onReset: vi.fn(),
          apiReady: true,
        }),
      { initialProps: { values: { name: 'A' } } },
    );
    expect(useSettingsSaveStore.getState().dirty).toBe(false);
    rerender({ values: { name: 'A2' } });
    expect(useSettingsSaveStore.getState().dirty).toBe(true);
    rerender({ values: { name: 'A' } });
    expect(useSettingsSaveStore.getState().dirty).toBe(false);
  });

  it('publishes apiReady to the store', () => {
    renderHook(() =>
      useDirtyForm({
        values: { name: 'A' },
        initialValues: { name: 'A' },
        onSave: vi.fn(),
        onReset: vi.fn(),
        apiReady: true,
      }),
    );
    expect(useSettingsSaveStore.getState().apiReady).toBe(true);
  });

  it('clears the store on unmount', () => {
    const onSave = vi.fn();
    const { unmount } = renderHook(() =>
      useDirtyForm({
        values: { name: 'B' },
        initialValues: { name: 'A' },
        onSave,
        onReset: vi.fn(),
        apiReady: true,
      }),
    );
    expect(useSettingsSaveStore.getState().dirty).toBe(true);
    unmount();
    expect(useSettingsSaveStore.getState().dirty).toBe(false);
    expect(useSettingsSaveStore.getState().onSave).toBeNull();
  });

  it('store.triggerSave invokes the registered onSave', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useDirtyForm({
        values: { name: 'B' },
        initialValues: { name: 'A' },
        onSave,
        onReset: vi.fn(),
        apiReady: true,
      }),
    );
    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('store.triggerDiscard invokes the registered onReset', () => {
    const onReset = vi.fn();
    renderHook(() =>
      useDirtyForm({
        values: { name: 'B' },
        initialValues: { name: 'A' },
        onSave: vi.fn(),
        onReset,
        apiReady: true,
      }),
    );
    act(() => {
      useSettingsSaveStore.getState().triggerDiscard();
    });
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
