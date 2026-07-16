import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useHelpShortcut } from './useHelpShortcut';
import { claimHelpShortcut } from './useGlobalShortcut';

describe('useHelpShortcut', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens the modal when `?` is pressed outside an editable target', () => {
    const onOpen = vi.fn();
    renderHook(() => useHelpShortcut(onOpen));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', cancelable: true }));

    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('does not fire while typing in an input', () => {
    const onOpen = vi.fn();
    renderHook(() => useHelpShortcut(onOpen));

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));

    expect(onOpen).not.toHaveBeenCalled();
  });

  it('ignores the chord when a modifier is held', () => {
    const onOpen = vi.fn();
    renderHook(() => useHelpShortcut(onOpen));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', metaKey: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', ctrlKey: true, cancelable: true }));

    expect(onOpen).not.toHaveBeenCalled();
  });

  it('yields to a surface that owns `?` (no double cheatsheet)', () => {
    const onOpen = vi.fn();
    renderHook(() => useHelpShortcut(onOpen));

    // A surface (the board / schedule build mode) claims `?` while mounted.
    const release = claimHelpShortcut();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', cancelable: true }));
    expect(onOpen).not.toHaveBeenCalled();

    // Once the surface unmounts and releases the claim, the global modal is
    // reachable again.
    release();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', cancelable: true }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
