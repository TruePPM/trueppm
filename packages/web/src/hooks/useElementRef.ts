/**
 * A callback ref paired with the mounted node as React state (issue #2365).
 *
 * Use this instead of `useRef` whenever an effect needs the DOM node itself —
 * to attach a listener, a `ResizeObserver`, an `IntersectionObserver`, or to
 * measure it.
 *
 * ## The bug this exists to prevent
 *
 * A `RefObject`'s identity never changes, and mutating `.current` does not
 * re-render. So the common shape
 *
 * ```ts
 * useEffect(() => {
 *   const el = ref.current;
 *   if (!el) return;        // <-- bails out
 *   el.addEventListener(...);
 * }, []);                   // <-- and never re-runs
 * ```
 *
 * is silently broken whenever the referenced node mounts *after* the first
 * commit — which is exactly what happens when the component returns a loading
 * skeleton or an error state before rendering the real container:
 *
 * 1. first commit renders the skeleton, so `ref.current` is `null`
 * 2. the effect runs, hits the early return, and wires up nothing
 * 3. the query resolves and the real container mounts
 * 4. the effect never re-runs, so the wiring is dead for that whole mount
 *
 * Because it depends on whether the data happened to be cached before the
 * component mounted, this presents as an intermittent failure rather than an
 * obvious one — it read as e2e flake for two triage rounds before being tracked
 * down (#1954 → #2365).
 *
 * With this hook the node is state, so the effect re-runs the moment it mounts:
 *
 * ```ts
 * const { el, setEl } = useElementRef<HTMLDivElement>();
 * useEffect(() => {
 *   if (!el) return;
 *   el.addEventListener(...);
 *   return () => el.removeEventListener(...);
 * }, [el]);                 // <-- re-runs when the node appears
 * return <div ref={setEl} />;
 * ```
 */
import { useCallback, useState } from 'react';

/** Return value of {@link useElementRef}. */
export interface ElementRef<T extends HTMLElement> {
  /**
   * The mounted node, or `null` before it mounts (and again after it
   * unmounts). Its identity changes when the node does, so it is safe — and
   * required — as an effect dependency.
   */
  el: T | null;
  /**
   * Attach to the JSX element: `ref={setEl}`. Stable across renders, so React
   * never detaches and re-attaches it.
   */
  setEl: (node: T | null) => void;
}

/**
 * Tracks a DOM node as state so effects can depend on it.
 *
 * @returns The mounted node and the callback ref that records it. See
 *   {@link ElementRef}.
 */
export function useElementRef<T extends HTMLElement = HTMLElement>(): ElementRef<T> {
  const [el, setElState] = useState<T | null>(null);
  // `useState`'s setter is already stable, but wrapping it keeps the returned
  // shape a plain callback ref rather than a `Dispatch<SetStateAction<T>>` —
  // passing the raw setter as a ref would let React's node argument be
  // mistaken for a functional-update callback if `T` were ever callable.
  const setEl = useCallback((node: T | null) => setElState(node), []);
  return { el, setEl };
}
