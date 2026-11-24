import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { ProjectViewSet, SeedDiff } from '@/api/types';

/** Cache key for one project's resolved view set (per user, so per session). */
export const projectViewsKey = (projectId: string | undefined) => ['project-views', projectId];

/** A payload that is not a view set (a proxy page, an old server) must fail open, not crash. */
export function isProjectViewSet(data: unknown): data is ProjectViewSet {
  return (
    typeof data === 'object' && data !== null && Array.isArray((data as { views?: unknown }).views)
  );
}

/**
 * `GET /projects/{id}/views/` — the caller's resolved view set (ADR-1478).
 *
 * The first read for a project applies the lens seed server-side, so the tabs wait for
 * this rather than paint the full set and prune it. `retry: false` because an error
 * fails open at once (the caller falls back to the unseeded composition) and the next
 * mount retries; retrying here would only hold the skeleton up longer.
 */
export function useProjectViews(projectId: string | undefined) {
  return useQuery({
    queryKey: projectViewsKey(projectId),
    enabled: !!projectId,
    retry: false,
    staleTime: 60_000,
    queryFn: async (): Promise<ProjectViewSet> => {
      const res = await apiClient.get<unknown>(`/projects/${projectId}/views/`);
      if (!isProjectViewSet(res.data)) throw new Error('Malformed view set');
      return res.data;
    },
  });
}

/** Body of `PATCH /projects/{id}/views/`; every field is optional. */
export interface ProjectViewsPatch {
  key?: string;
  hidden?: boolean;
  seed_line_dismissed?: boolean;
  lens_offer_dismissed?: string;
  clear_seed?: boolean;
  last_layouts?: Record<string, string>;
}

/** `PATCH /projects/{id}/views/` — the response is the new resolved set, written straight into the cache. */
export function useUpdateProjectViews(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: ProjectViewsPatch) => {
      const res = await apiClient.patch<ProjectViewSet>(`/projects/${projectId}/views/`, body);
      return res.data;
    },
    onSuccess: (data) => queryClient.setQueryData(projectViewsKey(projectId), data),
  });
}

/**
 * `POST …/views/apply-seed/`. `dry_run: true` returns the diff for the confirm and writes
 * nothing; `dry_run: false` rewrites only seed entries, then the view set is refetched.
 */
export function useApplyLensSeed(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { lens: string; dry_run: boolean }) => {
      const res = await apiClient.post<SeedDiff>(`/projects/${projectId}/views/apply-seed/`, body);
      return res.data;
    },
    onSuccess: (diff) => {
      if (diff.applied)
        void queryClient.invalidateQueries({ queryKey: projectViewsKey(projectId) });
    },
  });
}

/**
 * `POST …/views/reset/` — restore the current lens's suggestions. Only seed entries are
 * rewritten; the person's own choices survive. The response is a diff, so the view set
 * is refetched rather than patched.
 */
export function useResetProjectViews(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.post<SeedDiff>(`/projects/${projectId}/views/reset/`);
      return res.data;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: projectViewsKey(projectId) }),
  });
}

/** The server's refusal copy (`{code, detail}`), or null for any other failure. */
export function viewsErrorDetail(error: unknown): string | null {
  const data = (error as { response?: { data?: unknown } } | null)?.response?.data;
  if (typeof data === 'object' && data !== null && 'detail' in data) {
    const detail = (data as { detail: unknown }).detail;
    if (typeof detail === 'string') return detail;
  }
  return null;
}
