import { describe, it, expect, afterEach, vi } from 'vitest';
import { formatChord, modifierKeyLabel, altKeyLabel } from './platform';

/**
 * #3028 — the same chord must render as something each platform's reader can
 * press. These assert BOTH platforms, because a test that only runs the Mac
 * branch is exactly how the shipped surfaces came to print ⌘ to everyone.
 */
function setPlatform(value: string) {
  vi.stubGlobal('navigator', { platform: value, userAgent: value });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('formatChord — Mac', () => {
  it('stacks glyphs with no separator, ⌘ trailing', () => {
    setPlatform('MacIntel');
    expect(formatChord('mod+alt+g')).toBe('⌥⌘G');
    expect(formatChord('mod+a')).toBe('⌘A');
  });

  it('renders arrows as glyphs', () => {
    setPlatform('MacIntel');
    expect(formatChord('alt+ArrowRight')).toBe('⌥→');
    expect(formatChord('alt+ArrowLeft')).toBe('⌥←');
  });

  it('orders modifiers ⌥⇧⌘, the platform convention', () => {
    setPlatform('MacIntel');
    expect(formatChord('mod+shift+alt+g')).toBe('⌥⇧⌘G');
  });
});

describe('formatChord — everywhere else', () => {
  it('spells the modifiers the reader actually has', () => {
    setPlatform('Linux x86_64');
    expect(formatChord('mod+alt+g')).toBe('Ctrl+Alt+G');
    expect(formatChord('mod+a')).toBe('Ctrl+A');
  });

  it('keeps arrow glyphs — they are universal', () => {
    setPlatform('Win32');
    expect(formatChord('alt+ArrowRight')).toBe('Alt+→');
  });

  it('never emits a Mac-only glyph', () => {
    setPlatform('Linux x86_64');
    for (const chord of ['mod+alt+g', 'mod+shift+m', 'alt+ArrowLeft', 'mod+d']) {
      expect(formatChord(chord)).not.toMatch(/[⌘⌥⇧]/);
    }
  });
});

describe('the existing labels agree with formatChord', () => {
  it('on Mac', () => {
    setPlatform('MacIntel');
    expect(modifierKeyLabel()).toBe('⌘');
    expect(altKeyLabel()).toBe('⌥');
  });

  it('elsewhere', () => {
    setPlatform('Linux x86_64');
    expect(modifierKeyLabel()).toBe('Ctrl');
    expect(altKeyLabel()).toBe('Alt');
  });
});
