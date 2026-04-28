import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useBoardKeyboard } from './useBoardKeyboard';

function dispatch(key: string, options: KeyboardEventInit = {}) {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options }));
}

describe('useBoardKeyboard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('fires onMoveCardFocus down on J or ArrowDown', () => {
    const onMoveCardFocus = vi.fn();
    renderHook(() => useBoardKeyboard({ onMoveCardFocus }));

    dispatch('j');
    expect(onMoveCardFocus).toHaveBeenLastCalledWith('down');

    dispatch('ArrowDown');
    expect(onMoveCardFocus).toHaveBeenLastCalledWith('down');
    expect(onMoveCardFocus).toHaveBeenCalledTimes(2);
  });

  it('fires onMoveColumnFocus across H/L/arrows', () => {
    const onMoveColumnFocus = vi.fn();
    renderHook(() => useBoardKeyboard({ onMoveColumnFocus }));

    dispatch('l');
    dispatch('ArrowRight');
    dispatch('h');
    dispatch('ArrowLeft');

    expect(onMoveColumnFocus.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      'right',
      'right',
      'left',
      'left',
    ]);
  });

  it('fires onShowDeps on D and onShowCheatsheet on ?', () => {
    const onShowDeps = vi.fn();
    const onShowCheatsheet = vi.fn();
    renderHook(() => useBoardKeyboard({ onShowDeps, onShowCheatsheet }));

    dispatch('d');
    expect(onShowDeps).toHaveBeenCalled();

    dispatch('?');
    expect(onShowCheatsheet).toHaveBeenCalled();
  });

  it('fires onCloseOverlay on Esc', () => {
    const onCloseOverlay = vi.fn();
    renderHook(() => useBoardKeyboard({ onCloseOverlay }));

    dispatch('Escape');
    expect(onCloseOverlay).toHaveBeenCalled();
  });

  it('suppresses shortcuts when typing in an input', () => {
    const onShowDeps = vi.fn();
    renderHook(() => useBoardKeyboard({ onShowDeps }));

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    expect(onShowDeps).not.toHaveBeenCalled();
  });

  it('suppresses shortcuts when meta/ctrl/alt is pressed', () => {
    const onMoveCardFocus = vi.fn();
    renderHook(() => useBoardKeyboard({ onMoveCardFocus }));

    dispatch('j', { metaKey: true });
    dispatch('j', { ctrlKey: true });
    dispatch('j', { altKey: true });

    expect(onMoveCardFocus).not.toHaveBeenCalled();
  });

  it('does nothing when enabled is false', () => {
    const onShowDeps = vi.fn();
    renderHook(() => useBoardKeyboard({ onShowDeps }, false));

    dispatch('d');
    expect(onShowDeps).not.toHaveBeenCalled();
  });

  it('skips shortcut handlers that are not provided', () => {
    // Should not throw or interfere with default browser behavior.
    renderHook(() => useBoardKeyboard({}));
    expect(() => dispatch('d')).not.toThrow();
    expect(() => dispatch('Enter')).not.toThrow();
  });
});
