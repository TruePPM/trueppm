import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useSearchParams, type SetURLSearchParams } from 'react-router';

/**
 * Write a single query param with replace semantics: set it when `value` is
 * truthy, drop the key entirely when it is null/empty so a clean view keeps a
 * clean URL.
 *
 * Always uses the functional-updater form so concurrent param writes within one
 * effect flush compose instead of clobbering each other — both updaters read the
 * live `prev` params rather than a stale captured snapshot. This is the guard
 * that stops a `?task=` write from wiping a sibling `?sprint=` written in the
 * same flush (#2031). Every single-param URL round-trip in the Board, Sprints,
 * Schedule, and Grid views routes through here.
 */
export function setSearchParam(
  setSearchParams: SetURLSearchParams,
  key: string,
  value: string | null,
): void {
  setSearchParams(
    (prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    },
    { replace: true },
  );
}

/**
 * URL-synced selection id for a view's task drawer (issues #2031, #2046).
 *
 * Seeds the selection from `?<key>=` in the `useState` initializer — not an
 * effect — so a `/board?task=<id>` deep-link opens the drawer on first paint,
 * then mirrors every open/close back into the URL so drawer state round-trips a
 * refresh or link-copy. The mirror effect bails when the URL already reflects
 * the selection: without that guard the mount pass fires a redundant write that,
 * within one effect flush, races the sibling `?sprint=` smart-default (both are
 * functional updaters reading the pre-navigation location) and clobbers it — the
 * #2031 regression this guard exists to prevent.
 *
 * Board and Sprints share this initializer-seeded shape. Schedule and Grid use a
 * two-phase ref latch instead (they scroll-to / open an app-wide drawer on
 * consume, and resolve the id against an async-loaded task tree), so they are
 * deliberately *not* folded into this hook — only the URL write is shared, via
 * {@link setSearchParam}.
 */
export function useUrlSelectedId(
  key: string,
): [string | null, Dispatch<SetStateAction<string | null>>] {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get(key));
  useEffect(() => {
    if (searchParams.get(key) === selectedId) return;
    setSearchParam(setSearchParams, key, selectedId);
  }, [key, selectedId, searchParams, setSearchParams]);
  return [selectedId, setSelectedId];
}
