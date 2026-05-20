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

/** Locked from ADR-0075 threat-model #4 — match the server-side cap. */
export const MAX_ATTACHMENT_SIZE_BYTES = 100 * 1024 * 1024;
/** Locked from ADR-0075 threat-model #5 — match the server-side allow-list. */
export const ALLOWED_ATTACHMENT_MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

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

interface CreateFileAttachmentVars {
  projectId: string;
  taskId: string;
  file: File;
}

interface CreateLinkAttachmentVars {
  projectId: string;
  taskId: string;
  externalUrl: string;
  externalTitle?: string;
}

type CreateAttachmentVars = CreateFileAttachmentVars | CreateLinkAttachmentVars;

function isFileUpload(vars: CreateAttachmentVars): vars is CreateFileAttachmentVars {
  return 'file' in vars;
}

/**
 * POST /api/v1/projects/{projectId}/tasks/{taskId}/attachments/
 *
 * Accepts either a file upload (multipart) or an external URL (JSON).
 * Cache invalidation on success surfaces the new row in the section grid.
 * Server enforces all locked constraints — size, MIME, scheme, per-task cap.
 * Client-side pre-checks (size + MIME) just give a friendlier error before
 * the upload spinner runs.
 */
export function useCreateAttachment() {
  const queryClient = useQueryClient();
  return useMutation<TaskAttachment, Error, CreateAttachmentVars>({
    mutationFn: async (vars) => {
      const path = `/projects/${vars.projectId}/tasks/${vars.taskId}/attachments/`;
      if (isFileUpload(vars)) {
        const form = new FormData();
        form.append('file', vars.file, vars.file.name);
        const res = await apiClient.post<TaskAttachment>(path, form, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        return res.data;
      }
      const res = await apiClient.post<TaskAttachment>(path, {
        external_url: vars.externalUrl,
        external_title: vars.externalTitle ?? '',
      });
      return res.data;
    },
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: attachmentsKey(vars.taskId) });
    },
  });
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
