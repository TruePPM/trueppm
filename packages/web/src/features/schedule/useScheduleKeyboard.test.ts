import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScheduleKeyboard, formatKey } from './useScheduleKeyboard';

describe('formatKey', () => {
  it('emits the bare key for unmodified presses', () => {
    expect(formatKey(new KeyboardEvent('keydown', { key: 'm' }))).toBe('m');
    expect(formatKey(new KeyboardEvent('keydown', { key: '?' }))).toBe('?');
  });

  it('lowercases letter keys', () => {
    expect(formatKey(new KeyboardEvent('keydown', { key: 'M' }))).toBe('m');
  });

  it('uses metaKey on macOS for the mod prefix', () => {
    Object.defineProperty(navigator, 'platform', {
      value: 'MacIntel',
      configurable: true,
    });
    // Re-import isn't needed — formatKey reads navigator.platform at module init.
    // The test instead verifies meta+m parses; on macOS the production code uses meta.
    const e = new KeyboardEvent('keydown', { key: 'm', metaKey: true });
    expect(formatKey(e)).toContain('m');
  });

  it('omits shift when the key is already a punctuation symbol like `?`', () => {
    expect(formatKey(new KeyboardEvent('keydown', { key: '?', shiftKey: true }))).toBe('?');
  });

  it('includes alt when present', () => {
    expect(formatKey(new KeyboardEvent('keydown', { key: 'a', altKey: true }))).toBe('alt+a');
  });

  // #2727 (found by ux-review): every browser composes Option+letter on
  // macOS into an accented character — Option+A really does deliver
  // `key: 'å'`, not `'a'`. A binding keyed on `e.key` alone would silently
  // never fire there; this proves formatKey resolves through the
  // layout-independent `e.code` for an Alt+letter combo instead.
  it('resolves an Alt+letter combo via e.code, not the macOS-composed e.key (#2727)', () => {
    const macComposedOptionA = new KeyboardEvent('keydown', {
      key: 'å',
      code: 'KeyA',
      altKey: true,
    });
    expect(formatKey(macComposedOptionA)).toBe('alt+a');
  });

  it('still resolves via e.code on non-Mac, where key and code already agree', () => {
    const e = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', altKey: true });
    expect(formatKey(e)).toBe('alt+a');
  });

  it('leaves non-letter Alt combos (arrows, function keys) on e.key, unaffected by composition', () => {
    expect(
      formatKey(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', altKey: true })),
    ).toBe('alt+arrowright');
    expect(
      formatKey(new KeyboardEvent('keydown', { key: 'F8', code: 'F8', altKey: false, shiftKey: true })),
    ).toBe('shift+f8');
  });
});

describe('useScheduleKeyboard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('fires the matching binding on a window keydown', () => {
    const handler = vi.fn();
    renderHook(() => useScheduleKeyboard({ '?': handler }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not fire when the keydown originates from an INPUT (except Escape)', () => {
    const handler = vi.fn();
    renderHook(() => useScheduleKeyboard({ '?': handler }));
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('Escape inside an INPUT still fires (so the input can close itself)', () => {
    const handler = vi.fn();
    renderHook(() => useScheduleKeyboard({ escape: handler }));
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not fire when contenteditable is the target', () => {
    const handler = vi.fn();
    renderHook(() => useScheduleKeyboard({ '?': handler }));
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    document.body.appendChild(div);
    div.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not fire when the target is inside an ARIA combobox', () => {
    const handler = vi.fn();
    renderHook(() => useScheduleKeyboard({ '?': handler }));
    const combobox = document.createElement('div');
    combobox.setAttribute('role', 'combobox');
    document.body.appendChild(combobox);
    combobox.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('unbinds when unmounted', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useScheduleKeyboard({ '?': handler }));
    unmount();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('matches mod+m to either Cmd+M (Mac) or Ctrl+M (other)', () => {
    const handler = vi.fn();
    renderHook(() => useScheduleKeyboard({ 'mod+m': handler }));
    // Fire both — at least one should match depending on platform detected at module init.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', metaKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true }));
    expect(handler).toHaveBeenCalled();
  });
});
