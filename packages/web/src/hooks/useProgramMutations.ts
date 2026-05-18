import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { Program, ProgramMethodology } from '@/api/types';

export interface CreateProgramInput {
  name: string;
  description?: string;
  methodology?: ProgramMethodology;
}

/**
 * POST /api/v1/programs/ — create a new program (ADR-0070).
 *
 * The API atomically inserts an OWNER ``ProgramMembership`` for the creator,
 * so on success the program is immediately visible in the list and usable.
 * Invalidates the ``['programs']`` cache so the sidebar and list page refetch.
 */
export function useCreateProgram(): UseMutationResult<Program, Error, CreateProgramInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateProgramInput) => {
      const res = await apiClient.post<Program>('/programs/', {
        name: input.name,
        description: input.description ?? '',
        methodology: input.methodology ?? 'HYBRID',
      });
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['programs'] });
    },
  });
}

export interface UpdateProgramInput {
  programId: string;
  patch: Partial<Pick<Program, 'name' | 'description' | 'methodology'>>;
}

/**
 * PATCH /api/v1/programs/{id}/ — update name/description/methodology. ADMIN+.
 */
export function useUpdateProgram(): UseMutationResult<Program, Error, UpdateProgramInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId, patch }: UpdateProgramInput) => {
      const res = await apiClient.patch<Program>(`/programs/${programId}/`, patch);
      return res.data;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['programs'] });
      void queryClient.invalidateQueries({ queryKey: ['programs', variables.programId] });
    },
  });
}

/**
 * DELETE /api/v1/programs/{id}/ — cascade delete (OWNER only).
 *
 * The API service layer removes all memberships in the same transaction so
 * the PROTECT FK does not block the delete. Caller-side: invalidate the list
 * and remove any cached per-program detail.
 */
export function useDeleteProgram(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (programId: string) => {
      await apiClient.delete(`/programs/${programId}/`);
    },
    onSuccess: (_data, programId) => {
      void queryClient.invalidateQueries({ queryKey: ['programs'] });
      queryClient.removeQueries({ queryKey: ['programs', programId] });
    },
  });
}

export interface AssignProjectToProgramInput {
  projectId: string;
  programId: string | null;
}

/**
 * PATCH /api/v1/projects/{id}/ — assign or unassign a project to a program.
 *
 * Cross-permission: requires ADMIN+ on the project AND on the target program
 * (and on the source program when moving away from one). Validation is enforced
 * server-side; the resulting 400 carries an actionable message that this hook
 * surfaces unchanged via its mutation error.
 */
export function useAssignProjectToProgram(): UseMutationResult<
  unknown,
  Error,
  AssignProjectToProgramInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, programId }: AssignProjectToProgramInput) => {
      const res = await apiClient.patch<unknown>(`/projects/${projectId}/`, {
        program: programId,
      });
      return res.data;
    },
    onSuccess: (_data, variables) => {
      // Project list shows the new program badge; sidebar uses the same query.
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      // The program's projects-tab subview reads from the program's projects list.
      if (variables.programId !== null) {
        void queryClient.invalidateQueries({
          queryKey: ['programs', variables.programId, 'projects'],
        });
      }
      // Re-fetch all program lists since counts change on either side.
      void queryClient.invalidateQueries({ queryKey: ['programs'] });
    },
  });
}
