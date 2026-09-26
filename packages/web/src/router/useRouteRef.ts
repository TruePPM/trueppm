import { useProject } from '@/hooks/useProject';
import { useProgram } from '@/hooks/useProgram';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { isResolveNotFound, useResolveRef } from '@/hooks/useResolveRef';
import { isUuid, type RefKind } from '@/lib/refPath';

/** Where a route param stands on its way to a UUID. */
export type RouteRefStatus =
  /** No param on this route (not a project/program route). */
  | 'none'
  /** Waiting on `/resolve/` — render the shell skeleton, nothing else. */
  | 'resolving'
  /** `id` is known. */
  | 'resolved'
  /** The resolver said 404 — indistinguishable from an object the caller cannot see. */
  | 'not-found'
  /** A key URL that has never been resolved, opened with no connection. */
  | 'offline';

export interface RouteRef {
  status: RouteRefStatus;
  /** The object's UUID once resolved. */
  id: string | undefined;
  /**
   * The segment the address bar should show: the object's current key (from the
   * loaded object, else the resolver), falling back to the UUID for a keyless
   * object and to the raw param until anything is known.
   */
  ref: string | undefined;
  /** A non-404 resolve failure (5xx, throttle) — the boundary re-throws it. */
  error: Error | null;
}

/**
 * Resolve a raw `:projectId` / `:programId` route param (ADR-1237 §7).
 *
 * - A UUID is already the id: no resolver call, ever. Its key comes from the
 *   object's detail query, which the shell issues anyway (deduped by TanStack).
 * - Anything else goes through `useResolveRef` — raw, never parsed here — answered
 *   from the cache when a loaded object already carries that key.
 *
 * The canonical `ref` prefers the **loaded object's** current key over the
 * resolver's answer, so a peer's rename (which updates the cached object over the
 * WebSocket) rewrites this client's URL on the next render.
 *
 * Internal to the boundary module and the id hooks — components call
 * `useProjectId()` / `useProgramId()`.
 */
export function useRouteRef(kind: RefKind, param: string | undefined): RouteRef {
  const online = useOnlineStatus();
  const paramIsUuid = isUuid(param);
  const resolved = useResolveRef(kind, paramIsUuid ? undefined : param);

  const id = paramIsUuid ? param : resolved.data?.type === kind ? resolved.data.id : undefined;

  // Both detail hooks are called unconditionally (rules of hooks); only the one
  // matching `kind` is enabled, and each shares the cache key its page already uses.
  const project = useProject(kind === 'project' ? id : undefined);
  const program = useProgram(kind === 'program' ? id : undefined);
  const liveKey = kind === 'project' ? project.data?.code : program.data?.code;

  if (!param) return { status: 'none', id: undefined, ref: undefined, error: null };

  const ref = liveKey?.trim()
    ? liveKey.trim()
    : (resolved.data?.canonical_ref ?? (paramIsUuid ? param : undefined) ?? param);

  if (id) return { status: 'resolved', id, ref, error: null };

  if (resolved.data && resolved.data.type !== kind) {
    // A `PLAT-T-10` pasted where a project key belongs resolves to a task; the
    // project route addresses projects only, so it is not this route's object.
    return { status: 'not-found', id: undefined, ref: param, error: null };
  }
  if (resolved.isError) {
    return isResolveNotFound(resolved.error)
      ? { status: 'not-found', id: undefined, ref: param, error: null }
      : { status: 'resolving', id: undefined, ref: param, error: resolved.error };
  }
  // TanStack pauses a query while offline (networkMode 'online'); with nothing
  // cached for this key there is no way to learn what it points at.
  if (!online || resolved.fetchStatus === 'paused') {
    return { status: 'offline', id: undefined, ref: param, error: null };
  }
  return { status: 'resolving', id: undefined, ref: param, error: null };
}
