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
import { useCurrentUser } from '@/hooks/useCurrentUser';
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

interface CreateCommentVars {
  projectId: string;
  taskId: string;
  body: string;
  /** Optional parent comment ID for a one-level reply. */
  parentId?: string | null;
}

interface OptimisticContext {
  previous: TaskComment[] | undefined;
  optimisticId: string;
}

/**
 * POST /api/v1/projects/{projectId}/tasks/{taskId}/comments/
 *
 * Optimistic append: the comment shows in the thread immediately, then is
 * replaced with the server's authoritative row on success. On error the
 * optimistic row rolls back and the mutation error surfaces via the caller's
 * `onError` handler — composer renders "Couldn't post. [Retry]".
 *
 * The server runs mention parsing + fan-out inside the same transaction,
 * so a 400 on `mention_resolution_failed` means the body referenced a
 * non-member user or hit the @all role gate.
 */
export function useCreateComment() {
  const queryClient = useQueryClient();
  const { user } = useCurrentUser();

  return useMutation<TaskComment, Error, CreateCommentVars, OptimisticContext>({
    mutationFn: async ({ projectId, taskId, body, parentId }) => {
      const res = await apiClient.post<TaskComment>(
        `/projects/${projectId}/tasks/${taskId}/comments/`,
        { body, parent: parentId ?? null },
      );
      return res.data;
    },
    onMutate: async ({ taskId, body, parentId }) => {
      const queryKey = ['task-comments', taskId];
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<TaskComment[]>(queryKey);
      const optimisticId = `optimistic-${Date.now()}`;
      const optimistic: TaskComment = {
        id: optimisticId,
        task: taskId,
        parent: parentId ?? null,
        author: user
          ? { id: user.id, username: user.username ?? '', display_name: user.display_name }
          : null,
        body,
        edited_at: null,
        created_at: new Date().toISOString(),
        is_deleted: false,
        deleted_at: null,
        deleted_by: null,
        acknowledged_count: 0,
        reaction_count: 0,
        has_my_acknowledgement: false,
        has_my_reaction: false,
        my_reaction_id: null,
      };
      queryClient.setQueryData<TaskComment[]>(queryKey, [...(previous ?? []), optimistic]);
      return { previous, optimisticId };
    },
    onError: (_err, { taskId }, context) => {
      // Roll back optimistic append on failure
      if (context) {
        queryClient.setQueryData<TaskComment[]>(['task-comments', taskId], context.previous);
      }
    },
    onSuccess: (_data, { taskId }) => {
      // Invalidate so the server's authoritative row replaces the optimistic one
      void queryClient.invalidateQueries({ queryKey: ['task-comments', taskId] });
    },
  });
}

interface UpdateCommentVars {
  projectId: string;
  taskId: string;
  commentId: string;
  body: string;
}

/**
 * PATCH /api/v1/projects/{projectId}/tasks/{taskId}/comments/{commentId}/
 *
 * Edit a comment's body. Only the author may edit, and only within 15 minutes
 * of posting (ADR-0075 #11) — the server returns 400 `comment_edit_window_closed`
 * once the window closes, which the caller's `onError` surfaces. Mirrors
 * {@link useUpdateNote}.
 */
export function useUpdateComment() {
  const queryClient = useQueryClient();
  return useMutation<TaskComment, Error, UpdateCommentVars>({
    mutationFn: async ({ projectId, taskId, commentId, body }) => {
      const res = await apiClient.patch<TaskComment>(
        `/projects/${projectId}/tasks/${taskId}/comments/${commentId}/`,
        { body },
      );
      return res.data;
    },
    onSuccess: (_data, { taskId }) => {
      void queryClient.invalidateQueries({ queryKey: commentsKey(taskId) });
    },
  });
}

interface DeleteCommentVars {
  projectId: string;
  taskId: string;
  commentId: string;
}

/**
 * DELETE /api/v1/projects/{projectId}/tasks/{taskId}/comments/{commentId}/
 *
 * Soft-delete a comment. Allowed for the author or any ADMIN+ (server-enforced).
 * Mirrors {@link useDeleteNote}.
 */
export function useDeleteComment() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, DeleteCommentVars>({
    mutationFn: async ({ projectId, taskId, commentId }) => {
      await apiClient.delete(`/projects/${projectId}/tasks/${taskId}/comments/${commentId}/`);
    },
    onSuccess: (_data, { taskId }) => {
      void queryClient.invalidateQueries({ queryKey: commentsKey(taskId) });
    },
  });
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
