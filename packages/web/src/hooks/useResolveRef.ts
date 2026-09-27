import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type UseQueryResult,
} from '@tanstack/react-query';
import axios from 'axios';
import { apiClient } from '@/api/client';
import type { ResolveResponse } from '@/api/types';
import { isUuid, type RefKind } from '@/lib/refPath';

/**
 * A resolution is a fact about the workspace that changes only when someone renames
 * a key, and a rename keeps the old key resolving (ADR-1237 §3). So it stays fresh
 * for an hour and lives in the cache for a day — long enough that a key URL opened
 * earlier in the session still works offline.
 */
const RESOLVE_STALE_MS = 60 * 60 * 1000;
const RESOLVE_GC_MS = 24 * 60 * 60 * 1000;

/** The TanStack Query key for one resolution. Shared by the boundary and the id hooks. */
export function resolveQueryKey(kind: RefKind, ref: string | undefined) {
  return ['resolve', kind, ref] as const;
}

interface CachedKeyed {
  id: string;
  code?: string | null;
  program?: string | null;
  program_detail?: { id?: string | null } | null;
}

function isKeyed(value: unknown): value is CachedKeyed {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

function candidates(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const record = data as { results?: unknown; items?: unknown };
    if (Array.isArray(record.results)) return record.results;
    if (Array.isArray(record.items)) return record.items;
  }
  return [data];
}

/**
 * Answer a key from objects already in the query cache, without a request.
 *
 * Case-insensitive, like the server. This is a lookup of the **current** key an
 * object the client already loaded carries — never a parse of the ref — so a
 * retired key or a `PLAT-T-10` reference simply misses here and goes to the
 * resolver. It is what makes the UUID→key rewrite free (the key came from the
 * cached project) and keeps a key URL working offline once its project is loaded.
 */
export function findCachedResolution(
  queryClient: QueryClient,
  kind: RefKind,
  ref: string,
): ResolveResponse | undefined {
  const wanted = ref.trim().toUpperCase();
  if (!wanted) return undefined;
  // Only the exact detail and list keys: project detail is ['project', id] and the
  // list ['projects']; programs use ['programs', id] and ['programs']. Longer keys
  // under the same root (['project', id, 'risks'] …) hold other shapes.
  const roots = kind === 'project' ? [['project'], ['projects']] : [['programs']];
  const isObjectKey = (key: QueryKey) =>
    key.length === 1 || (key.length === 2 && typeof key[1] === 'string');
  for (const root of roots) {
    const entries = queryClient.getQueriesData<unknown>({
      queryKey: root,
      predicate: (query) => isObjectKey(query.queryKey),
    });
    for (const [, data] of entries) {
      for (const row of candidates(data)) {
        if (!isKeyed(row) || !row.code || row.code.toUpperCase() !== wanted) continue;
        const programId =
          kind === 'program' ? row.id : (row.program_detail?.id ?? row.program ?? null);
        return {
          type: kind,
          id: row.id,
          project_id: kind === 'project' ? row.id : null,
          program_id: programId,
          key: row.code,
          canonical_ref: row.code,
        };
      }
    }
  }
  return undefined;
}

/**
 * `GET /api/v1/resolve/?kind=&ref=` — turn a route param into the UUID every other
 * endpoint takes (ADR-1237 §5, §7).
 *
 * `ref` is passed through **raw**: a key, a retired key, a UUID or a `PLAT-T-10`
 * reference. The web never splits a reference itself — that would be a second
 * implementation an MCP or headless client could not share. A UUID never reaches
 * the network (the id is already known) and a key the cache already holds is
 * answered from it via {@link findCachedResolution}.
 *
 * A 404 is terminal (not retried): the server returns the same body for "missing"
 * and "you cannot see it", and so must the UI.
 *
 * @param kind - `'project'` or `'program'` — the namespace the ref belongs to.
 * @param ref - The raw route param, or `undefined` to disable the query.
 * @returns The TanStack Query result, cached under `['resolve', kind, ref]`.
 */
export function useResolveRef(
  kind: RefKind,
  ref: string | undefined,
): UseQueryResult<ResolveResponse> {
  const queryClient = useQueryClient();
  const enabled = typeof ref === 'string' && ref.length > 0 && !isUuid(ref);
  return useQuery({
    queryKey: resolveQueryKey(kind, ref),
    queryFn: async () => {
      const res = await apiClient.get<ResolveResponse>('/resolve/', { params: { kind, ref } });
      return res.data;
    },
    enabled,
    initialData: () => (enabled ? findCachedResolution(queryClient, kind, ref) : undefined),
    staleTime: RESOLVE_STALE_MS,
    gcTime: RESOLVE_GC_MS,
    retry: (failureCount, error) => {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status !== undefined && status >= 400 && status < 500) return false;
      return failureCount < 1;
    },
  });
}

/** Whether a resolve error is the "not found / not visible" answer (404, or a 403 edge). */
export function isResolveNotFound(error: unknown): boolean {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  return status === 404 || status === 403 || status === 400;
}
