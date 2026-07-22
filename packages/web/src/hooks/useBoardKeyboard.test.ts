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

  it('fires onMoveCardFocus down on J always, and on ArrowDown once focus is active', () => {
    const onMoveCardFocus = vi.fn();
    renderHook(() => useBoardKeyboard({ onMoveCardFocus, boardFocusActive: true }));

    dispatch('j');
    expect(onMoveCardFocus).toHaveBeenLastCalledWith('down');

    dispatch('ArrowDown');
    expect(onMoveCardFocus).toHaveBeenLastCalledWith('down');
    expect(onMoveCardFocus).toHaveBeenCalledTimes(2);
  });

  it('fires onMoveColumnFocus across H/L/arrows when board focus is active', () => {
    const onMoveColumnFocus = vi.fn();
    renderHook(() => useBoardKeyboard({ onMoveColumnFocus, boardFocusActive: true }));

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

  // #2205: an idle board (no virtual focus) must NOT swallow the four Arrow keys,
  // or it kills native page scroll window-wide. j/k/l/h still bootstrap focus.
  it('does not claim Arrow keys while board focus is inactive, but j/k/l/h still fire', () => {
    const onMoveCardFocus = vi.fn();
    const onMoveColumnFocus = vi.fn();
    renderHook(() =>
      useBoardKeyboard({ onMoveCardFocus, onMoveColumnFocus /* boardFocusActive: false */ }),
    );

    // Arrows are ignored (fall through to native scroll)…
    for (const arrow of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      const ev = new KeyboardEvent('keydown', { key: arrow, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(onMoveCardFocus).not.toHaveBeenCalled();
    expect(onMoveColumnFocus).not.toHaveBeenCalled();

    // …but j/k/l/h always work and can bootstrap the focus.
    dispatch('j');
    dispatch('k');
    dispatch('l');
    dispatch('h');
    expect(onMoveCardFocus).toHaveBeenCalledTimes(2);
    expect(onMoveColumnFocus).toHaveBeenCalledTimes(2);
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

  it('fires onOpenCard on Enter', () => {
    const onOpenCard = vi.fn();
    renderHook(() => useBoardKeyboard({ onOpenCard }));
    dispatch('Enter');
    expect(onOpenCard).toHaveBeenCalled();
  });

  it('fires onEditCard on E', () => {
    const onEditCard = vi.fn();
    renderHook(() => useBoardKeyboard({ onEditCard }));
    dispatch('e');
    expect(onEditCard).toHaveBeenCalled();
  });

  it('fires onShowComments on C', () => {
    const onShowComments = vi.fn();
    renderHook(() => useBoardKeyboard({ onShowComments }));
    dispatch('c');
    expect(onShowComments).toHaveBeenCalled();
  });

  it('fires onMoveCardFocus up on K always, and on ArrowUp once focus is active', () => {
    const onMoveCardFocus = vi.fn();
    renderHook(() => useBoardKeyboard({ onMoveCardFocus, boardFocusActive: true }));

    dispatch('k');
    expect(onMoveCardFocus).toHaveBeenLastCalledWith('up');

    dispatch('ArrowUp');
    expect(onMoveCardFocus).toHaveBeenLastCalledWith('up');
    expect(onMoveCardFocus).toHaveBeenCalledTimes(2);
  });

  it('suppresses shortcuts when inside a textarea', () => {
    const onShowDeps = vi.fn();
    renderHook(() => useBoardKeyboard({ onShowDeps }));

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    expect(onShowDeps).not.toHaveBeenCalled();

    document.body.removeChild(textarea);
  });

  it('suppresses shortcuts when inside an ARIA combobox', () => {
    const onShowDeps = vi.fn();
    renderHook(() => useBoardKeyboard({ onShowDeps }));

    const combobox = document.createElement('div');
    combobox.setAttribute('role', 'combobox');
    document.body.appendChild(combobox);

    combobox.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    expect(onShowDeps).not.toHaveBeenCalled();

    document.body.removeChild(combobox);
  });

  it('suppresses shortcuts when inside a select element', () => {
    const onShowDeps = vi.fn();
    renderHook(() => useBoardKeyboard({ onShowDeps }));

    const select = document.createElement('select');
    document.body.appendChild(select);
    select.focus();

    select.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    expect(onShowDeps).not.toHaveBeenCalled();

    document.body.removeChild(select);
  });

  it('does not fire any handler for an unrecognized key', () => {
    const onOpenCard = vi.fn();
    const onMoveCardFocus = vi.fn();
    renderHook(() => useBoardKeyboard({ onOpenCard, onMoveCardFocus }));
    // 'x' is not mapped
    dispatch('x');
    expect(onOpenCard).not.toHaveBeenCalled();
    expect(onMoveCardFocus).not.toHaveBeenCalled();
  });

  it('Escape key is a no-op when onCloseOverlay is not provided', () => {
    renderHook(() => useBoardKeyboard({}));
    // Should not throw
    expect(() => dispatch('Escape')).not.toThrow();
  });

  it('does not throw for movement/action keys when their handlers are not provided', () => {
    // Exercises the false branch of each `if (handlers.onX)` guard
    renderHook(() => useBoardKeyboard({}));
    const noOpKeys = ['k', 'ArrowUp', 'l', 'ArrowRight', 'h', 'ArrowLeft', 'e', 'c', '?'];
    for (const key of noOpKeys) {
      expect(() => dispatch(key)).not.toThrow();
    }
  });

  it('does not call onMoveCardFocus when it is not provided (k key)', () => {
    // Covers the false branch of `if (handlers.onMoveCardFocus)` in the k/ArrowUp case
    renderHook(() => useBoardKeyboard({ onOpenCard: vi.fn() }));
    expect(() => dispatch('k')).not.toThrow();
    expect(() => dispatch('ArrowUp')).not.toThrow();
  });

  it('does not call onMoveColumnFocus when it is not provided (l/h keys)', () => {
    // Covers the false branch of `if (handlers.onMoveColumnFocus)` in the l/h/arrow cases
    renderHook(() => useBoardKeyboard({ onOpenCard: vi.fn() }));
    expect(() => dispatch('l')).not.toThrow();
    expect(() => dispatch('ArrowRight')).not.toThrow();
    expect(() => dispatch('h')).not.toThrow();
    expect(() => dispatch('ArrowLeft')).not.toThrow();
  });

  it('does not call onEditCard when it is not provided', () => {
    renderHook(() => useBoardKeyboard({ onOpenCard: vi.fn() }));
    expect(() => dispatch('e')).not.toThrow();
  });

  it('does not call onShowComments when it is not provided', () => {
    renderHook(() => useBoardKeyboard({ onOpenCard: vi.fn() }));
    expect(() => dispatch('c')).not.toThrow();
  });

  it('does not call onShowCheatsheet when it is not provided', () => {
    renderHook(() => useBoardKeyboard({ onOpenCard: vi.fn() }));
    expect(() => dispatch('?')).not.toThrow();
  });

  it('suppresses shortcuts when typing in an input element', () => {
    const onShowDeps = vi.fn();
    renderHook(() => useBoardKeyboard({ onShowDeps }));

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    expect(onShowDeps).not.toHaveBeenCalled();

    document.body.removeChild(input);
  });
});
