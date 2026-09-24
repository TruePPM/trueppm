/**
 * useScheduleLegendCollapsed — Schedule view legend overlay visibility (#474,
 * ADR-0064; default-closed-after-first-visit + toolbar toggle added #3614).
 *
 * Persists whether the floating legend on the Gantt canvas is open or closed.
 * `collapsed` lives in a MODULE-level external store rather than local
 * `useState` because two independent consumers — the toolbar's "Legend"
 * button (`ScheduleLegendToggle`) and the legend panel's own close control
 * (`ScheduleLegend`) — read and write the SAME boolean and must stay in sync
 * within one tab. A `StorageEvent` cannot do that on its own: it never fires
 * in the document that made the write, only in *other* tabs. This follows the
 * subscriber + `useSyncExternalStore` shape `lib/featureFlags.ts` uses for the
 * identical problem (a localStorage-backed preference read by more than one
 * component instance). State is per-browser via localStorage and synchronized
 * across tabs via the StorageEvent, same as before.
 *
 * Default (#3614): a 280×300px panel with no dismiss control occluded most of
 * a ~320px Gantt pane at 1280 — permanently, because the legend defaulted to
 * open on EVERY visit, not just the first. Now: open on the user's
 * first-ever visit, closed on every visit after — unless the user has
 * explicitly opened or closed it, which always wins over the seen-based
 * default.
 *
 * `useSyncExternalStore` requires `getSnapshot()` to return the SAME value on
 * every call until `notifySubscribers()` fires — React calls it on every
 * render of every subscribed instance, not only when the store actually
 * changed, and a value that drifts without a notification is exactly the
 * "tearing" the API exists to prevent. That rules out deriving the seen-based
 * fallback fresh on each call: the legend panel's OWN mount marks itself seen
 * moments after first rendering open, and if that write were visible to the
 * very next `getSnapshot()` call, the panel (or a sibling `useSyncExternalStore`
 * consumer re-rendering for any unrelated reason) would flip itself closed
 * one render after opening — which is a real bug this file shipped with once
 * (#3614 follow-up: caught in e2e, not unit tests, because jsdom/RTL's
 * `renderHook` never re-renders a component for reasons unrelated to its own
 * hooks the way a live app constantly does). So the fallback is resolved
 * ONCE — the first time any consumer calls `getSnapshot()` — and cached for
 * the rest of this module's lifetime (effectively, one real page load).
 * "First visit" therefore means the first page load that ever showed the
 * legend open, not each individual mount within one SPA session; navigating
 * away from Schedule and back without reloading keeps whatever this session
 * already decided.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'trueppm.schedule.legend.collapsed.v1';
/** Set the first time the legend has actually been shown open (#3614). */
const SEEN_KEY = 'trueppm.schedule.legend.seen.v1';

const subscribers = new Set<() => void>();

function notifySubscribers(): void {
  for (const cb of subscribers) cb();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) cb();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    subscribers.delete(cb);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

function hasBeenSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === 'true';
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, 'true');
  } catch {
    /* localStorage unavailable — non-fatal, the open-once default just repeats */
  }
}

// Resolved lazily (not eagerly at module evaluation) so a test can reset
// localStorage before the first hook render and still observe a fresh
// decision, and so a build that never mounts a Schedule view never pays for
// a localStorage read it does not need. Cached from that point on for this
// module's lifetime — see the file header for why re-deriving per call is
// unsound under `useSyncExternalStore`.
let cachedOpenByDefault: boolean | null = null;

function openByDefault(): boolean {
  cachedOpenByDefault ??= !hasBeenSeen();
  return cachedOpenByDefault;
}

function getSnapshot(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    // An explicit choice — collapsed OR expanded — always wins over the
    // seen-based default below.
    if (stored !== null) return stored === 'true';
    return !openByDefault();
  } catch {
    return false;
  }
}

function getServerSnapshot(): boolean {
  return false;
}

function write(collapsed: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(collapsed));
  } catch {
    /* localStorage unavailable — degrade silently to in-memory state */
  }
  notifySubscribers();
}

export function useScheduleLegendCollapsed(): {
  collapsed: boolean;
  toggle: () => void;
  setCollapsed: (next: boolean) => void;
} {
  const collapsed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = useCallback(() => {
    write(!collapsed);
  }, [collapsed]);

  const setCollapsed = useCallback((next: boolean) => {
    write(next);
  }, []);

  return { collapsed, toggle, setCollapsed };
}

/**
 * Marks the legend seen once it has actually rendered open, so the NEXT page
 * load with no explicit user choice defaults to closed instead of open
 * forever (#3614). Persists to localStorage only — it deliberately never
 * touches `cachedOpenByDefault` or calls `notifySubscribers()`, both of which
 * would let this write flip what is currently on screen (see the file
 * header). It cannot affect this session; it can only affect the next one.
 *
 * Deliberately NOT folded into `useScheduleLegendCollapsed` itself:
 * `ScheduleLegendToggle` (the toolbar button) also calls that hook, and the
 * toolbar mounts well before task data has loaded and `ScheduleLegend`
 * (gated on `visibleTasks.length > 0`) exists at all. Only `ScheduleLegend` —
 * the thing that was actually shown — calls this.
 */
export function useMarkScheduleLegendSeen(open: boolean): void {
  useEffect(() => {
    if (open) markSeen();
  }, [open]);
}
