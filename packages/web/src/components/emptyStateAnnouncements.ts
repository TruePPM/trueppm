import { useEffect } from 'react';

/**
 * Empty-state announcement registry (#3198, ADR-0989).
 *
 * `EmptyState` used to carry `role="status"` on its own container. That put the
 * live region into the accessibility tree *together with* its text — the shape
 * web-rule 335 calls unreliable across AT — and it re-fired on every mount,
 * including the remounts a route change or a project switch produce with no
 * user-facing news.
 *
 * The announcement is therefore owned here rather than by the component, and
 * spoken through the single persistent region `<EmptyStateAnnouncer/>` mounts in
 * the shell. A registry is what makes "transition into empty" expressible at
 * all: a component can only observe *its own* mount, which is the same event
 * whether the surface just became empty or was already empty before a remount.
 * Only the set of empty surfaces alive across a settle boundary distinguishes
 * the two.
 */

/**
 * Coalescing window. Two things ride on it, and both are why it is not zero:
 *
 *  - a surface with N simultaneously-empty blocks (a Board with four empty
 *    columns) registers N times in one commit and must announce once;
 *  - a route change unmounts the old `EmptyState` and mounts the new one in the
 *    same commit, so the registry dips to empty and back. Settling after the
 *    dip is what makes "still empty, different component instance" silent.
 */
const SETTLE_MS = 500;

let nextId = 0;
/** Live `EmptyState` titles, insertion-ordered — "first one wins" reads this order. */
const live = new Map<number, string>();
/** The titles that were on screen at the previous settle. */
let settled = new Set<string>();
let message = '';
let settleTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
/**
 * Toggled per announcement to append an inaudible trailing space. Two
 * consecutive announcements of the *same* string would otherwise be one
 * unchanged text node, and React skips the DOM mutation the AT listens for —
 * the same device `RouteAnnouncer` uses for two routes sharing a title.
 */
let pad = false;

function emit(text: string): void {
  pad = !pad;
  message = text + (pad ? ' ' : '');
  for (const l of listeners) l();
}

function settle(): void {
  settleTimer = null;
  const current = new Set(live.values());
  // The first title on screen now that was not on screen at the previous
  // settle. Absence of one is the whole of "nothing transitioned into empty" —
  // it covers empty→populated, a remount at unchanged emptiness, and a filter
  // change that leaves the same surface empty.
  let fresh: string | undefined;
  for (const title of live.values()) {
    if (!settled.has(title)) {
      fresh = title;
      break;
    }
  }
  settled = current;
  if (fresh !== undefined) emit(fresh);
}

function schedule(): void {
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, SETTLE_MS);
}

/**
 * Register a mounted empty surface's heading. Returns the unregister function,
 * so it is directly usable as a `useEffect` cleanup.
 */
export function registerEmptyStateTitle(title: string): () => void {
  const id = nextId++;
  live.set(id, title);
  schedule();
  return () => {
    live.delete(id);
    schedule();
  };
}

export function subscribeEmptyStateAnnouncement(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getEmptyStateAnnouncement(): string {
  return message;
}

/**
 * Announce this surface's heading when — and only when — the surface transitions
 * into empty. Called by `EmptyState` and by the bespoke empty states web-rule
 * 177 licenses; there is nothing for a call site to pass or wire up.
 */
export function useEmptyStateAnnouncement(title: string): void {
  useEffect(() => registerEmptyStateTitle(title), [title]);
}

/**
 * Drop the spoken message and the settled set, keeping live registrations.
 *
 * Called when the announcer mounts. The store is module-level and outlives an
 * `AppShell` unmount — a throw bubbling to the `RequireAuth` net takes the shell
 * down, and so does logging out — so without this the remounted region would
 * enter the accessibility tree already carrying the previous session's sentence.
 * That is the rule-335 defect this whole component exists to remove, wearing
 * stale text. Clearing `settled` alongside it is what keeps the new session from
 * being deafened: an equally-empty surface must announce again for the user who
 * just logged in, because for them it genuinely is news.
 *
 * `live` is deliberately untouched — child effects run before the parent's, so
 * empty surfaces below the shell have already registered by the time this runs.
 */
export function resetEmptyStateAnnouncerSession(): void {
  settled = new Set();
  if (message !== '') {
    message = '';
    for (const l of listeners) l();
  }
}

/** Test-only: drop all registry state so specs do not inherit each other's. */
export function resetEmptyStateAnnouncerForTest(): void {
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = null;
  nextId = 0;
  live.clear();
  settled = new Set();
  message = '';
  pad = false;
  listeners.clear();
}
