/**
 * Data hook + types for the unified Assets surface (ADR-0215, #971).
 *
 * Consumes `GET /{scope}/{id}/assets/` — a read-only, newest-first feed that
 * merges every task's files (`TaskAttachment`) and external links (`TaskLink`)
 * across a project (or a program's readable member projects) into one
 * `AssetItem` stream with a stable opaque keyset cursor (`next_cursor`).
 * Filtering (kind / label / provider / q) is server-side; the cursor is opaque —
 * the client only echoes it back.
 */

import { useInfiniteQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

export type AssetKind = 'file' | 'link';

/** The owning task reference on an asset row (click-through target). */
export interface AssetTaskRef {
  id: string;
  name: string;
}

/** Minimal actor — who added the asset (files only; links have no uploader). */
export interface AssetUser {
  id: string;
  display_name: string;
}

/** One unified asset — a file or an external link. Link-only fields
 *  (`provider`/`status`/`preview_type`) are null on files; `labels` is `[]` on
 *  files; `download_url` is the signed-url action target on stored files and null
 *  on external-URL attachments and links; `added_by` is null on links. */
export interface AssetItem {
  kind: AssetKind;
  id: string;
  title: string;
  url: string | null;
  download_url: string | null;
  provider: string | null;
  status: string | null;
  preview_type: string | null;
  labels: string[];
  task: AssetTaskRef;
  added_by: AssetUser | null;
  added_at: string;
}

export interface AssetFeedResponse {
  results: AssetItem[];
  next_cursor: string | null;
}

/** Client filter state. `kind` null = both; `label`/`provider` null = unfiltered. */
export interface AssetFilterState {
  kind: AssetKind | null;
  label: string | null;
  provider: string | null;
  q: string;
}

export const DEFAULT_ASSET_FILTERS: AssetFilterState = {
  kind: null,
  label: null,
  provider: null,
  q: '',
};

const PAGE_SIZE = 30;

/** Build the server query params from the current filter state (pure — unit-tested). */
export function assetParams(filters: AssetFilterState): Record<string, string> {
  const params: Record<string, string> = { page_size: String(PAGE_SIZE) };
  if (filters.kind) params.kind = filters.kind;
  if (filters.label) params.label = filters.label;
  if (filters.provider) params.provider = filters.provider;
  const q = filters.q.trim();
  if (q) params.q = q;
  return params;
}

type AssetScope = 'projects' | 'programs';

function useAssetFeed(scope: AssetScope, id: string | undefined, filters: AssetFilterState) {
  return useInfiniteQuery({
    queryKey: ['assets', scope, id, filters.kind, filters.label, filters.provider, filters.q],
    queryFn: async ({ pageParam }) => {
      const params = assetParams(filters);
      if (pageParam) params.cursor = pageParam;
      const res = await apiClient.get<AssetFeedResponse>(`/${scope}/${id}/assets/`, { params });
      return res.data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!id,
    staleTime: 15 * 1000,
  });
}

/** Infinite Assets feed for a single project. */
export function useProjectAssets(projectId: string | undefined, filters: AssetFilterState) {
  return useAssetFeed('projects', projectId, filters);
}

/** Infinite Assets feed across a program's readable member projects. */
export function useProgramAssets(programId: string | undefined, filters: AssetFilterState) {
  return useAssetFeed('programs', programId, filters);
}

/** Known link providers offered as provider filter chips (stable, data-independent). */
export const ASSET_PROVIDERS: { value: string; label: string }[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab', label: 'GitLab' },
  { value: 'google_drive', label: 'Drive' },
  { value: 'dropbox', label: 'Dropbox' },
  { value: 'box', label: 'Box' },
  { value: 'onedrive', label: 'OneDrive' },
  { value: 'generic', label: 'Link' },
];

/**
 * Resolve a file attachment's signed download URL on demand and open it. Files
 * never expose their raw storage path — the feed carries the signed-url action
 * target (`download_url`, prefixed `/api/v1`), which returns a short-lived signed
 * URL. Strip the API prefix so the auth-carrying `apiClient` (baseURL `/api/v1`)
 * doesn't double it. Reuses the exact attachment signed-url mechanism (ADR-0215).
 */
export async function openAssetDownload(downloadUrl: string): Promise<void> {
  const path = downloadUrl.replace(/^\/api\/v1/, '');
  const res = await apiClient.get<{ url: string; expires_at: string }>(path);
  if (res.data?.url) {
    window.open(res.data.url, '_blank', 'noopener,noreferrer');
  }
}
