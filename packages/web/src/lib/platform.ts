/**
 * OS / platform detection for keyboard-shortcut affordances.
 *
 * The v2 command palette and shortcut chips must show the OS-correct modifier
 * (⌘ on Mac, Ctrl elsewhere) per the design handoff (01-shell-and-ia.md). Kept
 * here as the single source so chips never hardcode one platform.
 */

/** True when running on a Mac/iOS-family platform. SSR/test-safe (false when no navigator). */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  // navigator.platform is deprecated but still the most reliable signal; fall
  // back to userAgentData (Chromium) and userAgent for resilience.
  const ua = navigator as Navigator & { userAgentData?: { platform?: string } };
  const source = ua.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
  return /Mac|iPhone|iPad|iPod/i.test(source);
}

/** The OS-correct primary modifier label: '⌘' on Mac, 'Ctrl' elsewhere. */
export function modifierKeyLabel(): string {
  return isMacPlatform() ? '⌘' : 'Ctrl';
}

/** The OS-correct secondary (Alt/Option) modifier label: '⌥' on Mac, 'Alt' elsewhere. */
export function altKeyLabel(): string {
  return isMacPlatform() ? '⌥' : 'Alt';
}
