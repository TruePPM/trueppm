/**
 * The one sanctioned way to apply an optimistic edit to a cached *list* (#2862).
 *
 * Every optimistic `onMutate` in this codebase follows the same three beats:
 * `cancelQueries` → read the current list → write an edited copy back. The
 * failure this module exists to make unrepresentable is in beat two: a cache
 * entry that is momentarily **absent** means "not loaded right now", never
 * "this collection is empty". Defaulting it to `[]` and writing that back
 * replaces a populated list with the single row the user just added — the
 * board-wipe closed by #2717, then found again on four sibling hooks in #2862.
 *
 * The window is real, not theoretical: `cancelQueries` is awaited, and an
 * `invalidateQueries` from a WebSocket collaboration handler, an offline
 * reconnect flush, or the mutation's own `onSuccess` can clear the entry inside
 * it. `useProjectWebSocket` invalidates `['task-comments', taskId]` and
 * `['task-notes', taskId]` on exactly the events that race a local compose.
 *
 * Two properties do the work, and neither survives being hand-rolled per hook:
 *
 * 1. **The updater is skipped entirely on a nullish entry.** No `?? []`, so a
 *    missing list is left missing and the mutation's own success/settled
 *    invalidate brings back the real list *including* the new row. A brief
 *    "nothing yet" is honest; a list that lost twelve rows is not.
 * 2. **The write reads the cache functionally, not from the earlier snapshot.**
 *    `setQueryData(key, (current) => …)` re-reads at write time, so an
 *    invalidation landing *between* the snapshot read and the write is seen by
 *    the updater rather than silently overwritten with pre-race data.
 *
 * The snapshot is still returned, because `onError` needs it to roll back.
 */

import type { QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * Apply `updater` to a cached list, no-op if the entry is absent.
 *
 * @param queryClient - The client whose cache is being patched.
 * @param queryKey - Key of the cached list. Must hold `T[]`, not an envelope.
 * @param updater - Pure edit over the *current* list. Only ever called with a
 *   real array, so it never has to defend against `undefined` itself.
 * @returns The list as it stood before the write, for `onError` rollback, or
 *   `undefined` when nothing was cached (in which case nothing was written).
 */
export function optimisticListUpdate<T>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  updater: (current: T[]) => T[],
): T[] | undefined {
  const previous = queryClient.getQueryData<T[]>(queryKey);
  queryClient.setQueryData<T[]>(queryKey, (current) => (current ? updater(current) : current));
  return previous;
}

/**
 * Append one entry to a cached list, no-op if the entry is absent.
 *
 * The overwhelmingly common case — a comment, note, or reply composed locally
 * and shown before the server confirms it. Sugar over
 * {@link optimisticListUpdate}; identical guarantees.
 */
export function optimisticListAppend<T>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  entry: T,
): T[] | undefined {
  return optimisticListUpdate<T>(queryClient, queryKey, (current) => [...current, entry]);
}
