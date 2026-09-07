import { apiClient } from './client';
import type { PaginatedResponse } from './types';

/**
 * Reduce a DRF `next`/`previous` link to a path relative to the apiClient
 * baseURL (`/api/v1`).
 *
 * DRF builds these with `request.build_absolute_uri`, so they arrive as
 * fully-qualified URLs whose path already contains `/api/v1`. Two ways to get
 * this wrong, and both have shipped:
 *
 * - Hand axios `new URL(next).pathname + search` and it double-prefixes the
 *   baseURL — `/api/v1/api/v1/tasks/?page=2` — which 404s (#3467).
 * - Hand axios the absolute URL untouched and it skips the baseURL (axios does
 *   not prefix an absolute URL), so the request goes to whatever host the
 *   server put in the link. That is the `Host` header the API happened to see,
 *   which under the Vite dev proxy (`changeOrigin: true`) is the API container
 *   rather than the page origin — a cross-origin request the browser refuses.
 *
 * Stripping everything up to and including `/api/v1` leaves a baseURL-relative
 * remainder that is correct regardless of the host, scheme, or proxy in front.
 * This is the ONLY place that transform lives; see `pagination.conformance.test.ts`.
 */
export function toApiRelativePath(nextUrl: string): string {
  return nextUrl.replace(/^.*\/api\/v1/, '');
}

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
 * are read, never `count`. The absolute `next` link is normalized by
 * `toApiRelativePath`.
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
    nextPath = res.data.next ? toApiRelativePath(res.data.next) : null;
    isFirstPage = false;
  }
  return rows;
}
