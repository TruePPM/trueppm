/**
 * Map over `items` with at most `limit` invocations of `fn` in flight at once,
 * resolving to the results in **input order**.
 *
 * `Promise.all(items.map(fn))` starts every invocation in the same tick. On the
 * Schedule initial load that meant one XHR per remaining page fired as a single
 * burst — ~25 simultaneous requests at the 5 000-task design ceiling, and again
 * for the dependencies query (issue 2277). A burst that size saturates the
 * browser's per-origin connection pool, so it starves the requests the rest of
 * the page needs to become interactive (project detail, shell stats, the
 * WebSocket handshake) without making the schedule itself arrive any sooner —
 * the connections queue in the browser either way.
 *
 * Semantics deliberately match `Promise.all`: results come back in input order
 * regardless of completion order, and the first rejection rejects the whole
 * call. It differs in one respect — work that has not started when a rejection
 * occurs is never started, so a failing page does not drag the remaining pages
 * along behind it.
 *
 * @param items  The inputs to map over.
 * @param limit  Maximum concurrent invocations of `fn`. Must be >= 1.
 * @param fn     Async mapper, receiving the item and its index.
 * @returns The mapped results, in the same order as `items`.
 * @throws RangeError if `limit` is less than 1.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`mapWithConcurrency: limit must be an integer >= 1, got ${limit}`);
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  // Set by whichever worker rejects first. Workers check it before claiming
  // another item so a failure stops the queue instead of letting the remaining
  // workers drain it — `Promise.all` below has already rejected by then, and
  // the extra requests would be unobservable work against a dead call.
  let failed = false;

  async function worker(): Promise<void> {
    // Each worker claims the next unstarted index and runs it to completion, so
    // the number of live `fn` calls never exceeds the number of workers.
    while (nextIndex < items.length && !failed) {
      const index = nextIndex++;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
