import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

describe('useUnsavedChangesGuard', () => {
  it('closes immediately when clean', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard({ dirty: false, onClose }));

    act(() => result.current.requestClose());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(result.current.guardOpen).toBe(false);
  });

  it('opens the guard instead of closing when dirty', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard({ dirty: true, onClose }));

    act(() => result.current.requestClose());
    expect(onClose).not.toHaveBeenCalled();
    expect(result.current.guardOpen).toBe(true);
  });

  it('keepEditing dismisses the prompt without closing', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard({ dirty: true, onClose }));

    act(() => result.current.requestClose());
    act(() => result.current.keepEditing());
    expect(result.current.guardOpen).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('discard closes the prompt and runs onClose', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard({ dirty: true, onClose }));

    act(() => result.current.requestClose());
    act(() => result.current.discard());
    expect(result.current.guardOpen).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape routes through requestClose (opens guard when dirty)', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard({ dirty: true, onClose }));

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(result.current.guardOpen).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not install an Escape listener when escapeToClose is false', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() =>
      useUnsavedChangesGuard({ dirty: false, onClose, escapeToClose: false }),
    );

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(result.current.guardOpen).toBe(false);
  });
});
