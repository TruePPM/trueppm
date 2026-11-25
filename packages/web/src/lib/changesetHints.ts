/**
 * Changeset grouping hints on structural writes (ADR-1477 §3, #3150).
 *
 * The server groups structural acts on a committed plan by
 * `(project, kind, surface, author)` inside a two-minute window. Two inputs to
 * that key only the client knows:
 *
 * - **`surface`** — which view made the edit. Without it every web write is
 *   `api`, so a Board drag would group with a Grid restructure (D10 forbids it).
 * - **`amend_group: "new"`** — closes the open group on events the server cannot
 *   see: a mode or surface change, Review opened, or a page unload. It rides the
 *   *next* structural write after the event, then clears.
 *
 * Both are attached in one place, the `apiClient` request interceptor, rather
 * than at each of the dozen mutation call sites: a call site that forgot the
 * hint would silently regroup, and nothing else would notice.
 *
 * Module state, not React state, on purpose: the interceptor runs outside the
 * tree, and there is one active surface per tab.
 */

/** The surfaces the server accepts; anything else it records as `api`. */
export type ChangesetSurface = 'grid' | 'gantt' | 'board' | 'outline' | 'api';

let surface: ChangesetSurface = 'api';
let mode: string | null = null;
/**
 * A fresh page load is, by definition, after an unload, so the first structural
 * write of a page session opens a new group. `pagehide` re-arms it for a page
 * restored from the back/forward cache, which keeps this module's state.
 */
let closePending = true;

/** Record the active surface and mode; a change of either closes the group. */
export function setChangesetSurface(next: ChangesetSurface, nextMode: string | null = null): void {
  if (next !== surface || nextMode !== mode) closePending = true;
  surface = next;
  mode = nextMode;
}

/** Close the open group: the next structural write starts a new entry. */
export function closeChangesetGroup(): void {
  closePending = true;
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', closeChangesetGroup);
}

/**
 * Method + path of every structural write route (ADR-1477 §2). Paths are matched
 * after the base URL, with or without the `/projects/{pk}` prefix. Undo
 * (`/restore/`) is deliberately absent: it retracts, it does not record.
 */
const STRUCTURAL: Array<{ method: string; path: RegExp }> = [
  { method: 'post', path: /^(\/projects\/[^/]+)?\/tasks\/$/ },
  { method: 'delete', path: /^(\/projects\/[^/]+)?\/tasks\/[^/]+\/$/ },
  { method: 'post', path: /^\/projects\/[^/]+\/tasks\/(reorder|bulk|group|ungroup)\/$/ },
  { method: 'post', path: /^(\/projects\/[^/]+)?\/tasks\/[^/]+\/(indent|outdent|reparent|split)\/$/ },
  { method: 'post', path: /^\/projects\/[^/]+\/phases\/$/ },
  { method: 'delete', path: /^\/projects\/[^/]+\/phases\/[^/]+\/$/ },
];

/** Whether `method url` is a structural write the changeset records. */
export function isStructuralWrite(method: string | undefined, url: string | undefined): boolean {
  if (!method || !url) return false;
  const m = method.toLowerCase();
  const path = url.split('?')[0].replace(/^https?:\/\/[^/]+/, '').replace(/^\/api\/v1/, '');
  return STRUCTURAL.some((r) => r.method === m && r.path.test(path));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype;
}

/**
 * Add the hints to a structural write's body. A body that is not a plain object
 * (FormData, an array, a string) is left untouched: the server reads hints only
 * from a dict body, so there is nothing to attach them to. The caller's own
 * `surface` or `amend_group` wins.
 */
export function withChangesetHints<T extends { method?: string; url?: string; data?: unknown }>(
  config: T,
): T {
  if (!isStructuralWrite(config.method, config.url)) return config;
  if (config.data !== undefined && !isPlainObject(config.data)) return config;
  const body: Record<string, unknown> = { ...(config.data) };
  if (body.surface === undefined) body.surface = surface;
  if (closePending && body.amend_group === undefined) body.amend_group = 'new';
  closePending = false;
  config.data = body;
  return config;
}

/** Test-only: reset to a fresh page session. */
export function resetChangesetHintsForTest(): void {
  surface = 'api';
  mode = null;
  closePending = true;
}
