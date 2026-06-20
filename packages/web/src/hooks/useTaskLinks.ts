/**
 * Hooks for git-aware task links (ADR-0049 §3, #637).
 *
 * Backed by /api/v1/projects/{projectId}/tasks/{taskId}/links/. List returns a
 * bare array (a task carries a handful of links). Create stores a link with the
 * provider resolved server-side from the URL (the client only hints); status
 * starts `unknown` — there is no fetch on add. Refresh is a synchronous (~5s)
 * call that updates the cached status; it returns 422 `credential_required`
 * when the provider needs a PAT the caller hasn't connected, which the UI turns
 * into a "Connect {provider}" affordance rather than an error.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { ExternalLinkStatus } from '@/lib/linkStatus';

// Re-exported from the canonical module (issue 767, ADR-0154) so existing importers
// of `ExternalLinkStatus` from this hook keep working.
export type { ExternalLinkStatus };

/** A git/PM link on a task. `provider` is server-resolved (may be an Enterprise key). */
export interface TaskExternalLink {
  id: string;
  url: string;
  provider: string;
  /** Provider-fetched title (PR/MR/issue), populated only by refresh. */
  title: string;
  /** User-supplied name (#970); takes display precedence over `title`. */
  custom_title: string;
  /** Free-text categorization tags (#970). */
  labels: string[];
  status: ExternalLinkStatus;
  fetched_at: string | null;
  display_order: number;
  server_version: number;
}

/** Display name precedence (#970): user title → provider title → raw URL. */
export function linkDisplayTitle(link: TaskExternalLink): string {
  return link.custom_title || link.title || link.url;
}

const linksKey = (taskId: string | null) => ['task-links', taskId];

function linksPath(projectId: string, taskId: string): string {
  return `/projects/${projectId}/tasks/${taskId}/links/`;
}

/** GET /projects/{projectId}/tasks/{taskId}/links/ */
export function useTaskLinks(projectId: string, taskId: string | null) {
  const query = useQuery({
    queryKey: linksKey(taskId),
    queryFn: async () => {
      const res = await apiClient.get<TaskExternalLink[]>(linksPath(projectId, taskId as string));
      return res.data;
    },
    enabled: !!taskId && !!projectId,
  });

  return {
    links: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

interface CreateLinkVars {
  projectId: string;
  taskId: string;
  url: string;
  customTitle?: string;
  labels?: string[];
}

/** POST /projects/{projectId}/tasks/{taskId}/links/ — provider resolved server-side. */
export function useCreateTaskLink() {
  const queryClient = useQueryClient();
  return useMutation<TaskExternalLink, Error, CreateLinkVars>({
    mutationFn: async ({ projectId, taskId, url, customTitle, labels }) => {
      const res = await apiClient.post<TaskExternalLink>(linksPath(projectId, taskId), {
        url,
        custom_title: customTitle ?? '',
        labels: labels ?? [],
      });
      return res.data;
    },
    onSuccess: (_data, { taskId }) => {
      void queryClient.invalidateQueries({ queryKey: linksKey(taskId) });
    },
  });
}

interface UpdateLinkVars {
  projectId: string;
  taskId: string;
  linkId: string;
  customTitle?: string;
  labels?: string[];
}

/** PATCH /projects/{projectId}/tasks/{taskId}/links/{linkId}/ — edit title/labels (#970). */
export function useUpdateTaskLink() {
  const queryClient = useQueryClient();
  return useMutation<TaskExternalLink, Error, UpdateLinkVars>({
    mutationFn: async ({ projectId, taskId, linkId, customTitle, labels }) => {
      const body: { custom_title?: string; labels?: string[] } = {};
      if (customTitle !== undefined) body.custom_title = customTitle;
      if (labels !== undefined) body.labels = labels;
      const res = await apiClient.patch<TaskExternalLink>(
        `${linksPath(projectId, taskId)}${linkId}/`,
        body,
      );
      return res.data;
    },
    onSuccess: (_data, { taskId }) => {
      void queryClient.invalidateQueries({ queryKey: linksKey(taskId) });
    },
  });
}

interface LinkIdVars {
  projectId: string;
  taskId: string;
  linkId: string;
}

/** DELETE /projects/{projectId}/tasks/{taskId}/links/{linkId}/ — soft-delete. */
export function useDeleteTaskLink() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, LinkIdVars>({
    mutationFn: async ({ projectId, taskId, linkId }) => {
      await apiClient.delete(`${linksPath(projectId, taskId)}${linkId}/`);
    },
    onSuccess: (_data, { taskId }) => {
      void queryClient.invalidateQueries({ queryKey: linksKey(taskId) });
    },
  });
}

/**
 * POST /projects/{projectId}/tasks/{taskId}/links/{linkId}/refresh/ (synchronous).
 *
 * Resolves to the updated link on success. On 422 the axios error carries
 * `response.data.code === 'credential_required'` (plus `provider`) so the row
 * can show a Connect affordance; the component inspects the rejection.
 */
export function useRefreshTaskLink() {
  const queryClient = useQueryClient();
  return useMutation<TaskExternalLink, Error, LinkIdVars>({
    mutationFn: async ({ projectId, taskId, linkId }) => {
      const res = await apiClient.post<TaskExternalLink>(
        `${linksPath(projectId, taskId)}${linkId}/refresh/`,
      );
      return res.data;
    },
    onSuccess: (_data, { taskId }) => {
      void queryClient.invalidateQueries({ queryKey: linksKey(taskId) });
    },
  });
}
