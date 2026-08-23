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

/**
 * Render a binding as the keystroke the reader can actually press (#3028).
 *
 * The Schedule's keyboard layer resolves `mod` to **Meta on Mac and Ctrl
 * everywhere else** (`useScheduleKeyboard.ts`), so a surface that prints `⌘` to
 * everyone tells the Linux and Windows majority — which is most of a
 * self-hosted product's users — to press a key their keyboard does not have.
 * That is #3020's defect ("teaching a dead key is worse than teaching nothing")
 * one platform over, and the chord guard cannot catch it: it asks whether a
 * chord is *bound*, and `mod+alt+g` is bound. The question here is whether it is
 * *spelled* for the reader.
 *
 * Takes the same token grammar the bindings use — `mod`, `alt`, `shift`, then
 * the key — so the spelling and the binding have one source. Anything the
 * grammar does not name (arrows, letters, `F2`) passes through untouched.
 *
 * @example formatChord('mod+alt+g')  // '⌥⌘G' on Mac, 'Ctrl+Alt+G' elsewhere
 * @example formatChord('alt+ArrowRight') // '⌥→' on Mac, 'Alt+→' elsewhere
 */
export function formatChord(chord: string): string {
  const mac = isMacPlatform();
  const ARROWS: Record<string, string> = {
    arrowright: '→',
    arrowleft: '←',
    arrowup: '↑',
    arrowdown: '↓',
    enter: '⏎',
    tab: '⇥',
  };

  const tokens = chord.split('+').filter(Boolean);
  const mods: string[] = [];
  let key = '';

  for (const raw of tokens) {
    const t = raw.toLowerCase();
    if (t === 'mod') mods.push(mac ? '⌘' : 'Ctrl');
    else if (t === 'alt' || t === 'option') mods.push(mac ? '⌥' : 'Alt');
    else if (t === 'shift') mods.push(mac ? '⇧' : 'Shift');
    else key = ARROWS[t] ?? (t.length === 1 ? t.toUpperCase() : raw);
  }

  // Mac stacks glyphs with no separator (⌥⌘G) — that is the platform's own
  // convention and what every Mac app does. Elsewhere the words need joining.
  if (mac) {
    // Canonical Mac order is ⌃⌥⇧⌘, so ⌘ trails its companions.
    const order = ['⌃', '⌥', '⇧', '⌘'];
    mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return mods.join('') + key;
  }
  return [...mods, key].filter(Boolean).join('+');
}
