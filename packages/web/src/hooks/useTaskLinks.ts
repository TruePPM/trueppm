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

export type ExternalLinkStatus = 'open' | 'draft' | 'merged' | 'closed' | 'unknown';

/** A git/PM link on a task. `provider` is server-resolved (may be an Enterprise key). */
export interface TaskExternalLink {
  id: string;
  url: string;
  provider: string;
  title: string;
  status: ExternalLinkStatus;
  fetched_at: string | null;
  display_order: number;
  server_version: number;
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
}

/** POST /projects/{projectId}/tasks/{taskId}/links/ — provider resolved server-side. */
export function useCreateTaskLink() {
  const queryClient = useQueryClient();
  return useMutation<TaskExternalLink, Error, CreateLinkVars>({
    mutationFn: async ({ projectId, taskId, url }) => {
      const res = await apiClient.post<TaskExternalLink>(linksPath(projectId, taskId), { url });
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
