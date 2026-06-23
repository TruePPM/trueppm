/**
 * Hooks for task notes (ADR-0143, issue 740).
 *
 * A note is an immutable, per-author, timestamped entry on a task's why/decision
 * log — distinct from the threaded {@link useTaskComments} discussion. The read
 * path returns the flat list (pinned-first, then newest) keyed by `taskId`. The
 * write paths are create (optimistic append), edit-within-window (PATCH body),
 * pin toggle, and soft-delete.
 *
 * The 15-minute self-edit window and the author-or-admin delete rule are both
 * enforced server-side; these hooks surface the server's verdict (a 403 turns
 * into the mutation's error state) rather than re-implementing the policy.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import type { TaskNote } from '@/types';

export const notesKey = (taskId: string | null) => ['task-notes', taskId];

/** GET /api/v1/projects/{projectId}/tasks/{taskId}/notes/ */
export function useTaskNotes(projectId: string, taskId: string | null) {
  const query = useQuery({
    queryKey: notesKey(taskId),
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<TaskNote>>(
        `/projects/${projectId}/tasks/${taskId}/notes/`,
      );
      return res.data.results;
    },
    enabled: !!taskId && !!projectId,
  });

  return {
    notes: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

interface CreateNoteVars {
  projectId: string;
  taskId: string;
  body: string;
}

interface OptimisticContext {
  previous: TaskNote[] | undefined;
  optimisticId: string;
}

/**
 * POST /api/v1/projects/{projectId}/tasks/{taskId}/notes/
 *
 * Optimistic append: the note shows immediately, then is replaced with the
 * server's authoritative row on success. On error the optimistic row rolls back
 * and the composer surfaces "Couldn't add note."
 */
export function useCreateNote() {
  const queryClient = useQueryClient();
  const { user } = useCurrentUser();

  return useMutation<TaskNote, Error, CreateNoteVars, OptimisticContext>({
    mutationFn: async ({ projectId, taskId, body }) => {
      const res = await apiClient.post<TaskNote>(
        `/projects/${projectId}/tasks/${taskId}/notes/`,
        { body },
      );
      return res.data;
    },
    onMutate: async ({ taskId, body }) => {
      const queryKey = notesKey(taskId);
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<TaskNote[]>(queryKey);
      const optimisticId = `optimistic-${Date.now()}`;
      const optimistic: TaskNote = {
        id: optimisticId,
        task: taskId,
        author: user
          ? { id: user.id, username: user.username ?? '', display_name: user.display_name }
          : null,
        body,
        pinned: false,
        decision: false,
        edited_at: null,
        created_at: new Date().toISOString(),
        is_deleted: false,
        deleted_at: null,
        deleted_by: null,
      };
      queryClient.setQueryData<TaskNote[]>(queryKey, [...(previous ?? []), optimistic]);
      return { previous, optimisticId };
    },
    onError: (_err, { taskId }, context) => {
      if (context) {
        queryClient.setQueryData<TaskNote[]>(notesKey(taskId), context.previous);
      }
    },
    onSuccess: (_data, { taskId }) => {
      // Invalidate so the server's authoritative row (and pinned-first ordering)
      // replaces the optimistic append.
      void queryClient.invalidateQueries({ queryKey: notesKey(taskId) });
    },
  });
}

interface UpdateNoteVars {
  projectId: string;
  taskId: string;
  noteId: string;
  body: string;
}

/**
 * PATCH /api/v1/projects/{projectId}/tasks/{taskId}/notes/{noteId}/
 *
 * Edit a note's body. Only the author may edit, and only within 15 minutes of
 * creation — the server returns 403 once the window closes, which the caller's
 * `onError` surfaces.
 */
export function useUpdateNote() {
  const queryClient = useQueryClient();
  return useMutation<TaskNote, Error, UpdateNoteVars>({
    mutationFn: async ({ projectId, taskId, noteId, body }) => {
      const res = await apiClient.patch<TaskNote>(
        `/projects/${projectId}/tasks/${taskId}/notes/${noteId}/`,
        { body },
      );
      return res.data;
    },
    onSuccess: (_data, { taskId }) => {
      void queryClient.invalidateQueries({ queryKey: notesKey(taskId) });
    },
  });
}

interface PinNoteVars {
  projectId: string;
  taskId: string;
  noteId: string;
}

/**
 * POST /api/v1/projects/{projectId}/tasks/{taskId}/notes/{noteId}/pin/
 *
 * Toggle a note's pinned state. Open to any MEMBER+ (separate from the author's
 * edit window). Re-fetches so the pinned-first ordering re-sorts.
 */
export function usePinNote() {
  const queryClient = useQueryClient();
  return useMutation<TaskNote, Error, PinNoteVars>({
    mutationFn: async ({ projectId, taskId, noteId }) => {
      const res = await apiClient.post<TaskNote>(
        `/projects/${projectId}/tasks/${taskId}/notes/${noteId}/pin/`,
      );
      return res.data;
    },
    onSuccess: (_data, { taskId }) => {
      void queryClient.invalidateQueries({ queryKey: notesKey(taskId) });
    },
  });
}

interface ToggleDecisionVars {
  projectId: string;
  taskId: string;
  noteId: string;
}

/**
 * POST /api/v1/projects/{projectId}/tasks/{taskId}/notes/{noteId}/decision/
 *
 * Toggle a note's `decision` flag — the seam that promotes a note into the project
 * and sprint Decisions views (ADR-0165, #748). Curation, not authorship: open to any
 * MEMBER+, like pin. Invalidates the per-task notes list (so the drawer chip flips)
 * and the project Decisions list (so an open Decisions view re-sorts).
 */
export function useToggleDecision() {
  const queryClient = useQueryClient();
  return useMutation<TaskNote, Error, ToggleDecisionVars>({
    mutationFn: async ({ projectId, taskId, noteId }) => {
      const res = await apiClient.post<TaskNote>(
        `/projects/${projectId}/tasks/${taskId}/notes/${noteId}/decision/`,
      );
      return res.data;
    },
    onSuccess: (_data, { projectId, taskId }) => {
      void queryClient.invalidateQueries({ queryKey: notesKey(taskId) });
      void queryClient.invalidateQueries({ queryKey: ['decisions', projectId] });
    },
  });
}

interface DeleteNoteVars {
  projectId: string;
  taskId: string;
  noteId: string;
}

/**
 * DELETE /api/v1/projects/{projectId}/tasks/{taskId}/notes/{noteId}/
 *
 * Soft-delete a note. Allowed for the author or any ADMIN+ (server-enforced).
 */
export function useDeleteNote() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, DeleteNoteVars>({
    mutationFn: async ({ projectId, taskId, noteId }) => {
      await apiClient.delete(`/projects/${projectId}/tasks/${taskId}/notes/${noteId}/`);
    },
    onSuccess: (_data, { taskId }) => {
      void queryClient.invalidateQueries({ queryKey: notesKey(taskId) });
    },
  });
}
