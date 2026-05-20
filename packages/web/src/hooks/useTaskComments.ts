/**
 * Hooks for task comments (ADR-0075 §A.2 / #311).
 *
 * Read path returns the full thread (parent + replies sorted by created_at)
 * keyed by (taskId). Write path is acknowledge (POST/DELETE) and react
 * (POST/DELETE) — comment-create lives in frontend phase 2 with the
 * Composer + MentionAutocomplete + offline queue.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';
import type { CommentAcknowledgement, CommentReaction, TaskComment } from '@/types';

const commentsKey = (taskId: string | null) => ['task-comments', taskId];

/** GET /api/v1/projects/{projectId}/tasks/{taskId}/comments/ */
export function useTaskComments(projectId: string, taskId: string | null) {
  const query = useQuery({
    queryKey: commentsKey(taskId),
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<TaskComment>>(
        `/projects/${projectId}/tasks/${taskId}/comments/`,
      );
      return res.data.results;
    },
    enabled: !!taskId && !!projectId,
  });

  return {
    comments: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

interface AcknowledgeVars {
  projectId: string;
  taskId: string;
  commentId: string;
  /** true → POST (add ack); false → DELETE (remove ack). */
  acknowledge: boolean;
}

/**
 * Toggle the user's ✅ on a comment.
 *
 * POST /api/v1/projects/{projectId}/tasks/{taskId}/comments/{id}/acknowledge/
 * DELETE /api/v1/projects/{projectId}/tasks/{taskId}/comments/{id}/acknowledge/
 *
 * Member+ required (gate enforced server-side per the rbac-check fix in
 * ee3a3b03). Never triggers a notification — Morgan's blocker.
 */
export function useAcknowledgeComment() {
  const queryClient = useQueryClient();
  return useMutation<CommentAcknowledgement | { deleted: number }, Error, AcknowledgeVars>({
    mutationFn: async ({ projectId, taskId, commentId, acknowledge }) => {
      const path = `/projects/${projectId}/tasks/${taskId}/comments/${commentId}/acknowledge/`;
      if (acknowledge) {
        const res = await apiClient.post<CommentAcknowledgement>(path);
        return res.data;
      }
      const res = await apiClient.delete<{ deleted: number }>(path);
      return res.data;
    },
    onSuccess: (_data, { taskId }) => {
      // Refetch so acknowledged_count + has_my_acknowledgement update.
      void queryClient.invalidateQueries({ queryKey: commentsKey(taskId) });
    },
  });
}

interface ReactVars {
  projectId: string;
  taskId: string;
  commentId: string;
  emoji: string;
  /** When provided, DELETE the existing reaction by id. Otherwise POST a new one. */
  reactionId?: string;
}

/**
 * Toggle a 👍 reaction on a comment.
 *
 * POST /api/v1/projects/{projectId}/tasks/{taskId}/comments/{commentId}/reactions/
 * DELETE /api/v1/projects/{projectId}/tasks/{taskId}/comments/{commentId}/reactions/{id}/
 *
 * 0.2 allow-list is {"👍"} — server rejects anything else with 400.
 * Never triggers a notification (ADR-0075 §A.4).
 */
export function useReactToComment() {
  const queryClient = useQueryClient();
  return useMutation<CommentReaction | void, Error, ReactVars>({
    mutationFn: async ({ projectId, taskId, commentId, emoji, reactionId }) => {
      const base = `/projects/${projectId}/tasks/${taskId}/comments/${commentId}/reactions/`;
      if (reactionId) {
        await apiClient.delete(`${base}${reactionId}/`);
        return;
      }
      const res = await apiClient.post<CommentReaction>(base, { emoji });
      return res.data;
    },
    onSuccess: (_data, { taskId }) => {
      void queryClient.invalidateQueries({ queryKey: commentsKey(taskId) });
    },
  });
}
