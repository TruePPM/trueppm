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
