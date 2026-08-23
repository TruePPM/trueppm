import { describe, it, expect, afterEach, vi } from 'vitest';
import { formatChord, modifierKeyLabel, altKeyLabel, isMacPlatform } from './platform';

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

/**
 * #3028 — which signal wins when they disagree.
 *
 * Not hypothetical: `playwright.config.ts` runs a **Windows user agent on a
 * macOS host**, so `userAgentData.platform` is "Windows" while
 * `navigator.platform` is "MacIntel". Preferring the hint made the keyboard
 * layer listen for Ctrl while Playwright's `ControlOrMeta` — which resolves from
 * the real host — pressed Meta, and every chord stopped firing. The failure
 * looked like "undo is broken", not "platform detection changed".
 */
describe('signal precedence', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('trusts the machine over a spoofed user agent', () => {
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgentData: { platform: 'Windows' },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    });
    expect(isMacPlatform()).toBe(true);
    expect(formatChord('mod+z')).toBe('⌘Z');
  });

  it('falls back to the hint when the machine reports nothing', () => {
    vi.stubGlobal('navigator', { platform: '', userAgentData: { platform: 'macOS' }, userAgent: '' });
    expect(isMacPlatform()).toBe(true);
  });

  it('is false when every signal says otherwise', () => {
    vi.stubGlobal('navigator', {
      platform: 'Linux x86_64',
      userAgentData: { platform: 'Linux' },
      userAgent: 'X11; Linux',
    });
    expect(isMacPlatform()).toBe(false);
  });
});
