import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';

export interface RapidComposeOptions {
  /** Commit a typed name. `opts.onError` restores the optimistically-cleared text. */
  onCommit: (name: string, opts?: { onError?: () => void }) => void;
  /** True while a create is in flight — `commit()` self-guards against a double-fire. */
  isPending: boolean;
  /** Escape handler, bound to the CONTAINER rather than the input (see below). */
  onClose: () => void;
}

export interface RapidCompose {
  value: string;
  setValue: (next: string) => void;
  /** Attach to the text input. Focused on mount. */
  inputRef: RefObject<HTMLInputElement | null>;
  /** Attach to the wrapper the Escape listener binds to. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Commit the current value, if any and not already in flight. */
  commit: () => void;
  /** `onKeyDown` for the input — Enter commits. */
  onInputKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** True when the value is blank or a create is in flight. */
  submitDisabled: boolean;
}

/**
 * The rapid-fire capture contract shared by every compose surface on the board.
 *
 * There are two surfaces with this behavior and they must not drift: the touch
 * `MobileComposeBar` (#2952) and the lane `LaneComposeField`. The *chrome* legitimately
 * differs — one is a bar fixed above the bottom nav, the other sits inside the cell a
 * card will land in — but the behavior is one contract, and it is the behavior that is
 * subtle. Four decisions live here rather than in either component, each of which was
 * a bug in some earlier version of this surface:
 *
 * * **Clear and re-focus BEFORE the mutation resolves**, so the next item can be typed
 *   immediately. Intake is bursty — a site walk produces five items, not one.
 * * **`onError` restores the text, but never clobbers a half-typed replacement.** The
 *   optimistic clear means a silent POST failure would otherwise lose the item with no
 *   trace (#2030); restoring unconditionally would eat what the user typed next.
 * * **Escape binds to the CONTAINER, not the input.** The field advertises
 *   `aria-keyshortcuts="Enter Escape"`, and once focus tabs onto Add or ×, an
 *   input-bound handler silently stops honoring the shortcut it advertises. It is a
 *   native listener rather than a JSX `onKeyDown` because the wrapper is a plain
 *   container: a JSX keyboard handler would make it a non-native interactive element,
 *   and giving it a role to satisfy that would make it announce as something it is not.
 * * **The pending field is `readOnly`, never `disabled`.** A disabled element is blurred
 *   by the browser, which on a phone closes the soft keyboard — and nothing re-focuses
 *   on re-enable, so every item after the first costs a tap plus a keyboard re-open.
 *   `commit()`'s own `isPending` guard is what prevents the double-fire.
 */
export function useRapidCompose({ onCommit, isPending, onClose }: RapidComposeOptions): RapidCompose {
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Held in a ref so the Escape listener binds once and never restages on a parent
  // re-render — the handler identity is not what the listener is for.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [value, setValue] = useState('');

  // Open with the caret already in the field. Pressing the affordance was the user
  // saying "I want to type"; making them click a second time to start is the friction
  // the modal had.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onCloseRef.current();
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, []);

  const commit = useCallback(() => {
    const name = value.trim();
    if (!name || isPending) return;
    setValue('');
    inputRef.current?.focus();
    onCommit(name, {
      onError: () => setValue((cur) => (cur === '' ? name : cur)),
    });
  }, [isPending, onCommit, value]);

  const onInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      commit();
    },
    [commit],
  );

  return {
    value,
    setValue,
    inputRef,
    containerRef,
    commit,
    onInputKeyDown,
    submitDisabled: isPending || value.trim() === '',
  };
}
