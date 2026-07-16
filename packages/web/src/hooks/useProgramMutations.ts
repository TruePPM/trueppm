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
  patch: Partial<
    Pick<
      Program,
      | 'name'
      | 'description'
      | 'code'
      | 'methodology'
      | 'iteration_label'
      | 'public_sharing'
      | 'allow_guests'
      | 'mc_history_enabled'
      | 'mc_history_retention_cap'
      | 'mc_history_attribution_audience'
      | 'task_duration_change_percent_policy'
      | 'attachments_enabled'
      | 'allowed_attachment_types'
      | 'calendar'
      | 'health'
      | 'target_date'
      | 'visibility'
      | 'lead'
      | 'color'
    >
  >;
}

/**
 * PATCH /api/v1/programs/{id}/ — update editable program fields. ADMIN+.
 *
 * Extended fields (``code``, ``health``, ``visibility``, ``lead``) ship with
 * #523. Caller is expected to send only the changed subset so unchanged fields
 * round-trip through the server's partial-update path unchanged.
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

// ---------------------------------------------------------------------------
// Program lifecycle (#530) — close / reopen / transfer-sponsorship / split
// ---------------------------------------------------------------------------

/** POST /api/v1/programs/:id/close/ — freeze the program shell (Owner only). */
export function useCloseProgram(): UseMutationResult<Program, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (programId: string) => {
      const res = await apiClient.post<Program>(`/programs/${programId}/close/`);
      return res.data;
    },
    onSuccess: (_data, programId) => {
      void queryClient.invalidateQueries({ queryKey: ['programs'] });
      void queryClient.invalidateQueries({ queryKey: ['programs', programId] });
    },
  });
}

/** POST /api/v1/programs/:id/reopen/ — restore writes to a closed program. */
export function useReopenProgram(): UseMutationResult<Program, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (programId: string) => {
      const res = await apiClient.post<Program>(`/programs/${programId}/reopen/`);
      return res.data;
    },
    onSuccess: (_data, programId) => {
      void queryClient.invalidateQueries({ queryKey: ['programs'] });
      void queryClient.invalidateQueries({ queryKey: ['programs', programId] });
    },
  });
}

export interface TransferSponsorshipInput {
  programId: string;
  new_owner_user_id: string;
  new_lead_user_id?: string;
}

/** POST /api/v1/programs/:id/transfer-sponsorship/ — hand sponsorship to another member. */
export function useTransferSponsorship(): UseMutationResult<
  Program,
  Error,
  TransferSponsorshipInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId, new_owner_user_id, new_lead_user_id }) => {
      const body: Record<string, string> = { new_owner_user_id };
      if (new_lead_user_id) body.new_lead_user_id = new_lead_user_id;
      const res = await apiClient.post<Program>(
        `/programs/${programId}/transfer-sponsorship/`,
        body,
      );
      return res.data;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['programs'] });
      void queryClient.invalidateQueries({ queryKey: ['programs', variables.programId] });
      void queryClient.invalidateQueries({
        queryKey: ['program-members', variables.programId],
      });
    },
  });
}

export interface SplitProgramInput {
  programId: string;
  splits: { name: string; project_ids: string[] }[];
}

export interface SplitProgramResult {
  /** The original program, now closed (read-only shell). */
  program: Program;
  /** The newly created sub-programs, in input order. */
  sub_programs: Program[];
}

/**
 * Surface the server's `{detail}` from a DRF 400 verbatim. The shared response
 * interceptor rejects with the raw AxiosError (whose `.message` is the generic
 * "Request failed with status code 400"), so the actionable validation message
 * — "Project X is not a project of this program.", "…at most 50 sub-programs." —
 * has to be lifted out of `response.data.detail` at the call site (the same
 * structural extraction `useTaskMutations` uses).
 */
function splitErrorMessage(err: unknown): string {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim() !== '') return detail;
  return err instanceof Error ? err.message : 'Could not split the program.';
}

/**
 * POST /api/v1/programs/:id/split/ — split a program into sub-programs (ADR-0156, #967).
 *
 * Each entry in ``splits`` becomes a new sub-program owned by the caller, and the
 * entry's projects move under it; any project left unassigned stays on the
 * original program, which the server closes after the split. The whole operation
 * is atomic and returns the closed parent plus the new sub-programs.
 *
 * A server 400 is re-thrown with its `{detail}` as the message so the dialog can
 * surface the validation reason verbatim. Invalidates the ``['programs']`` cache —
 * this prefix covers the programs list (sidebar/list page, where the new
 * sub-programs appear), the parent's detail (``['programs', id]``, now closed),
 * and the parent's projects subview (``['programs', id, 'projects']``, where the
 * redistributed projects left). The caller owns navigation, because the parent is
 * now a read-only shell.
 */
export function useSplitProgram(): UseMutationResult<SplitProgramResult, Error, SplitProgramInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId, splits }) => {
      try {
        const res = await apiClient.post<SplitProgramResult>(`/programs/${programId}/split/`, {
          splits,
        });
        return res.data;
      } catch (err) {
        throw new Error(splitErrorMessage(err));
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['programs'] });
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
