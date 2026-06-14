import { afterEach, describe, expect, it } from 'vitest';
import { isMacPlatform, modifierKeyLabel } from './platform';

function setPlatform(platform: string) {
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
  // userAgentData takes precedence in the impl; clear it so platform is used.
  Object.defineProperty(window.navigator, 'userAgentData', { value: undefined, configurable: true });
}

describe('platform', () => {
  afterEach(() => {
    Object.defineProperty(window.navigator, 'platform', { value: '', configurable: true });
  });

  it('detects Mac platforms', () => {
    setPlatform('MacIntel');
    expect(isMacPlatform()).toBe(true);
    expect(modifierKeyLabel()).toBe('⌘');
  });

  it('detects iOS platforms', () => {
    setPlatform('iPhone');
    expect(isMacPlatform()).toBe(true);
  });

  it('treats non-Apple platforms as Ctrl', () => {
    setPlatform('Win32');
    expect(isMacPlatform()).toBe(false);
    expect(modifierKeyLabel()).toBe('Ctrl');
  });

  it('falls back to Ctrl for Linux', () => {
    setPlatform('Linux x86_64');
    expect(modifierKeyLabel()).toBe('Ctrl');
  });
});
