/**
 * Hooks for task attachments (ADR-0075 §A.1 / #310).
 *
 * Read path returns the live list keyed by (taskId). Writes (delete, signed-URL
 * mint, pin toggle) trigger cache invalidation. Upload + drag-drop UI lives
 * in frontend phase 2 alongside the offline IndexedDB queue; this module
 * provides the API surface that phase 2 will wire onto.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';
import type { SignedDownloadUrl, TaskAttachment } from '@/types';

const attachmentsKey = (taskId: string | null) => ['task-attachments', taskId];

/** GET /api/v1/projects/{projectId}/tasks/{taskId}/attachments/ */
export function useTaskAttachments(projectId: string, taskId: string | null) {
  const query = useQuery({
    queryKey: attachmentsKey(taskId),
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<TaskAttachment>>(
        `/projects/${projectId}/tasks/${taskId}/attachments/`,
      );
      return res.data.results;
    },
    enabled: !!taskId && !!projectId,
  });

  return {
    attachments: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

interface DeleteAttachmentVars {
  projectId: string;
  taskId: string;
  attachmentId: string;
}

/** DELETE /api/v1/projects/{projectId}/tasks/{taskId}/attachments/{id}/ */
export function useDeleteAttachment() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, DeleteAttachmentVars>({
    mutationFn: async ({ projectId, taskId, attachmentId }) => {
      await apiClient.delete(
        `/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}/`,
      );
    },
    onSuccess: (_data, { taskId }) => {
      void queryClient.invalidateQueries({ queryKey: attachmentsKey(taskId) });
    },
  });
}

interface SignedUrlVars {
  projectId: string;
  taskId: string;
  attachmentId: string;
  /** Optional TTL override in seconds. Clamped server-side to 60-min max. */
  ttl?: number;
}

/**
 * GET /api/v1/projects/{projectId}/tasks/{taskId}/attachments/{id}/signed-url/
 *
 * Used at click-time for downloads — the URL is short-lived (15 min default,
 * 60 min OSS hard-cap per ADR-0075 locked constraint #6/#7). Browser opens
 * the URL immediately so the leak window stays tiny.
 */
export function useSignedDownloadUrl() {
  return useMutation<SignedDownloadUrl, Error, SignedUrlVars>({
    mutationFn: async ({ projectId, taskId, attachmentId, ttl }) => {
      const res = await apiClient.get<SignedDownloadUrl>(
        `/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}/signed-url/`,
        ttl ? { params: { ttl } } : undefined,
      );
      return res.data;
    },
  });
}
