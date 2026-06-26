import { apiClient } from './client';
import type { PaginatedResponse } from './types';

/**
 * Fetch every page of a DRF-paginated list endpoint and return the flattened
 * rows, following the `next` link until it is exhausted.
 *
 * Use this for admin/settings surfaces that render a full list with no
 * "load more" UI. As of issue 1317 these endpoints are page-bounded per request, so
 * this trades one potentially huge response for several bounded ones: the
 * per-request OOM / slow-query risk the pagination removed is gone even though
 * the client still accumulates the whole list. (For a "recent N" surface, read
 * `response.results` directly instead — do not page through unbounded history.)
 *
 * Works for both page-number and cursor pagination: only `results` and `next`
 * are read, never `count`. DRF emits an absolute `next` URL
 * (`request.build_absolute_uri`); we reduce it to a path relative to the
 * apiClient baseURL (`/api/v1`) so axios doesn't double-prefix it.
 */
export async function fetchAllPages<T>(
  path: string,
  params?: Record<string, unknown>,
): Promise<T[]> {
  const rows: T[] = [];
  let nextPath: string | null = path;
  let isFirstPage = true;
  while (nextPath) {
    const url: string = nextPath;
    const res = await apiClient.get<PaginatedResponse<T>>(
      url,
      isFirstPage ? { params } : undefined,
    );
    rows.push(...res.data.results);
    // Strip everything up to and including `/api/v1` so the remainder is
    // baseURL-relative regardless of host/scheme in the absolute `next`.
    nextPath = res.data.next ? res.data.next.replace(/^.*\/api\/v1/, '') : null;
    isFirstPage = false;
  }
  return rows;
}
