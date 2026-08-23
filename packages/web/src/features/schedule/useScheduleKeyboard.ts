import { useEffect, useRef } from 'react';
import { isMacPlatform } from '@/lib/platform';
import { isTypingInInput } from '@/hooks/useGlobalShortcut';

/**
 * View-scoped keyboard handler for the Schedule. Single home for global key
 * bindings so each new shortcut does not re-implement the "is the user typing
 * in a field?" gate.
 *
 * Key format examples: `?`, `mod+m` (⌘M on macOS, Ctrl+M elsewhere), `escape`.
 * The matcher is case-insensitive on letters and tolerates the literal `?` key
 * regardless of shift state.
 *
 * Bindings are matched against the current platform's modifier convention —
 * pass `mod+x` and the hook resolves to `metaKey` on macOS, `ctrlKey` else.
 *
 * Bindings whose key fires inside a text-entry surface (`<input>`,
 * `<textarea>`, `<select>`, `contenteditable`, or an ARIA combobox) are
 * silently ignored via the shared {@link isTypingInInput} guard, so a literal
 * `?` typed into a search box does not open a Schedule cheatsheet. `Escape` is
 * exempt — it is commonly used to close the input itself.
 */
export type KeyBindings = Record<string, (e: KeyboardEvent) => void>;

// One platform detector for the whole app (#3028): this decides which physical
// modifier `mod` matches, and `formatChord` decides how it is spelled. They must
// not be able to disagree — a layer that matches Ctrl while the coach bar prints
// ⌘ is exactly the defect this consolidation removes.
const isMac = isMacPlatform();

/**
 * The key token itself. Holding Alt/Option while pressing a letter on macOS
 * composes `KeyboardEvent.key` into an accented/special character (Option+A
 * → `'å'`, not `'a'`) — every browser does this, it's platform IME behavior,
 * not a bug in any one of them. A binding keyed on `e.key.toLowerCase()`
 * therefore silently never matches an Alt+letter combo on Mac (#2727, found
 * by ux-review). `e.code` is the *physical* key — layout- and OS-independent
 * — so an Alt+letter combo resolves through it instead; every other key
 * (arrows, function keys, `?`, etc.) is unaffected by Option composition and
 * keeps using `e.key`.
 */
function resolveKeyToken(e: KeyboardEvent): string {
  if (e.altKey && /^Key[A-Z]$/.test(e.code)) {
    return e.code.slice(3).toLowerCase();
  }
  return e.key.toLowerCase();
}

export function formatKey(e: KeyboardEvent): string {
  const parts: string[] = [];
  // Use `mod` as the platform-neutral name so `mod+m` resolves on either OS.
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('mod');
  if (e.shiftKey && e.key !== '?') parts.push('shift');
  if (e.altKey) parts.push('alt');
  // `e.key` is "?" already on shift+/ in most layouts; avoid double-shift below.
  parts.push(resolveKeyToken(e));
  return parts.join('+');
}

export function useScheduleKeyboard(bindings: KeyBindings): void {
  // Refs keep the binding identity stable across renders without re-binding the
  // window listener every time the parent re-renders.
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isTypingInInput(e.target) && e.key !== 'Escape') return;
      const key = formatKey(e);
      const fn = bindingsRef.current[key];
      if (fn) fn(e);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
