/**
 * ComposerDirtyContext — lets the free-text composers inside the task drawer
 * (comment, reply, decision-log note) register "I have unstaged text" with the
 * drawer, so its unsaved-changes guard covers them (#2153).
 *
 * Before this, `dirty` derived solely from the scalar draft (name/notes/O/M/P),
 * so a half-written comment was invisible to the guard: an Escape or a swap to
 * another task silently destroyed it. Composer text is deliberately kept OUT of
 * the scalar `dirty` (which drives the Save bar — the bar saves scalar fields,
 * not composer text); it feeds only the *dismiss/swap* decision via the drawer's
 * combined `guardDirty`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from 'react';

type SetComposerDirty = (id: string, dirty: boolean) => void;

const ComposerDirtyContext = createContext<SetComposerDirty | null>(null);

interface ComposerDirtyProviderProps {
  /** Called whenever the set of dirty composers becomes empty / non-empty. */
  onDirtyChange: (anyDirty: boolean) => void;
  children: ReactNode;
}

/**
 * Aggregates the dirty state of every composer rendered beneath it. Each
 * composer owns a stable id; the provider tracks the set of currently-dirty ids
 * and notifies the drawer only when the aggregate flips (empty ↔ non-empty).
 */
export function ComposerDirtyProvider({ onDirtyChange, children }: ComposerDirtyProviderProps) {
  const idsRef = useRef<Set<string>>(new Set());
  const anyDirtyRef = useRef(false);
  const setDirty = useCallback<SetComposerDirty>(
    (id, dirty) => {
      const ids = idsRef.current;
      const had = ids.has(id);
      if (dirty === had) return; // no change for this composer
      if (dirty) ids.add(id);
      else ids.delete(id);
      // Notify only when the AGGREGATE flips, so adding a second dirty composer
      // (or clearing one of several) doesn't churn the drawer's state.
      const anyDirty = ids.size > 0;
      if (anyDirty !== anyDirtyRef.current) {
        anyDirtyRef.current = anyDirty;
        onDirtyChange(anyDirty);
      }
    },
    [onDirtyChange],
  );
  return <ComposerDirtyContext.Provider value={setDirty}>{children}</ComposerDirtyContext.Provider>;
}

/**
 * Register a composer's unstaged-text state with the enclosing drawer. Reports
 * on every empty↔non-empty transition and unregisters on unmount (so closing a
 * reply box or swapping tabs clears its contribution). A no-op outside a
 * provider — composers used elsewhere keep their own dismissal.
 */
export function useReportComposerDirty(hasText: boolean): void {
  const setDirty = useContext(ComposerDirtyContext);
  const id = useId();
  useEffect(() => {
    if (!setDirty) return undefined;
    setDirty(id, hasText);
    return () => setDirty(id, false);
  }, [setDirty, id, hasText]);
}
