import type { Page, Route } from '@playwright/test';

/**
 * A **stateful** task store for specs that assert on the DOM *after* a write.
 *
 * The default `setupApiMocks` task route is stateless: every `GET /tasks/` re-serves
 * the same fixture array. That is fine for a spec that only reads, and a silent race
 * for a spec that writes — because `useUpdateTask` patches the cache optimistically in
 * `onMutate` and then **invalidates `['tasks', projectId]` in `onSuccess`**. The refetch
 * that the app's own success handler triggers re-serves the *original* fixture, so the
 * committed value survives only the few tens of milliseconds between the optimistic
 * render and the refetch landing. Under CI worker contention Playwright's poll misses
 * that window and the spec fails — nondeterministically, and only ever on a loaded
 * runner (#2752). `useScheduleTasks`' 2 s `refetchInterval` closes the same window a
 * second time even where nothing invalidates.
 *
 * Raising the assertion timeout does not help: after the refetch the value is gone
 * permanently, so a 5 s and a 60 s `toBeVisible` fail identically. The fix is to make
 * the read endpoint echo the write, which is what a real server does.
 *
 * Register AFTER `setupApiMocks` — Playwright matches routes in reverse registration
 * order, so the last registration wins. Requests this store does not own
 * (`POST`, `DELETE`, nested paths like `/tasks/{id}/notes/`) fall through via
 * `route.fallback()`, leaving existing mocks untouched.
 *
 * ```ts
 * const store = await setupTaskStore(page, { tasks: FIXTURE_TASKS });
 * // ... commit an edit ...
 * await expect.poll(() => store.patches.length).toBeGreaterThan(0);
 * await expect(page.getByText('the committed name')).toBeVisible(); // stable, not a race
 * ```
 */

/** A task row as the API serializes it. Specs supply whichever fields they assert on. */
export type TaskRow = Record<string, unknown>;

export interface TaskStoreOptions {
  /** The rows the store starts with — what `GET /tasks/` returns before any write. */
  tasks: TaskRow[];
  /**
   * Project a PATCH body onto the stored row. Defaults to a shallow merge.
   *
   * Supply this whenever a write field is **write-only** on the serializer and reads
   * back under a different name — `owners` (write) → `assignments` (read), for example.
   * A shallow merge would otherwise put a field on the row that the real API never
   * returns, and the spec would be asserting against a shape the server cannot produce.
   */
  applyPatch?: (body: Record<string, unknown>, current: TaskRow) => TaskRow;
}

export interface TaskStoreHandle {
  /** PATCH bodies the app sent, in order — the request-side contract to assert on. */
  patches: Record<string, unknown>[];
  /** The store's current rows: exactly what the next refetch will return. */
  rows: () => TaskRow[];
}

/** `/api/v1/tasks/<id>/` and nothing deeper — a nested path is not this store's. */
const DETAIL_PATH = /\/api\/v1\/tasks\/([^/]+)\/$/;

export async function setupTaskStore(
  page: Page,
  opts: TaskStoreOptions,
): Promise<TaskStoreHandle> {
  const rows: TaskRow[] = opts.tasks.map((t) => ({ ...t }));
  const patches: Record<string, unknown>[] = [];
  const applyPatch =
    opts.applyPatch ?? ((body: Record<string, unknown>, current: TaskRow) => ({ ...current, ...body }));

  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route('**/api/v1/tasks/**', async (route: Route) => {
    const request = route.request();
    const method = request.method();
    const id = DETAIL_PATH.exec(new URL(request.url()).pathname)?.[1];

    if (method === 'GET') {
      if (id === undefined) {
        return route.fulfill(
          json({ count: rows.length, next: null, previous: null, results: rows }),
        );
      }
      const row = rows.find((r) => r.id === id);
      return row
        ? route.fulfill(json(row))
        : route.fulfill(json({ detail: 'Not found.' }, 404));
    }

    if (method === 'PATCH' && id !== undefined) {
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      patches.push(body);
      const index = rows.findIndex((r) => r.id === id);
      if (index < 0) return route.fulfill(json({ detail: 'Not found.' }, 404));
      // The write lands in the store BEFORE the response resolves, so the refetch the
      // app fires from `onSuccess` can only ever observe the committed state.
      rows[index] = applyPatch(body, rows[index]);
      return route.fulfill(json(rows[index]));
    }

    return route.fallback();
  });

  return { patches, rows: () => rows.map((r) => ({ ...r })) };
}
