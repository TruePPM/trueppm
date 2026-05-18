import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { ProgramMembership } from '@/api/types';

interface AddPayload {
  user: string;
  role: number;
}

interface RolePayload {
  membershipId: string;
  role: number;
}

export function useAddProgramMember(
  programId: string,
): UseMutationResult<ProgramMembership, Error, AddPayload> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: AddPayload) => {
      const res = await apiClient.post<ProgramMembership>(
        `/programs/${programId}/members/`,
        payload,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['program-members', programId] });
      void queryClient.invalidateQueries({ queryKey: ['programs', programId] });
      void queryClient.invalidateQueries({ queryKey: ['programs'] });
    },
  });
}

export function useUpdateProgramMemberRole(
  programId: string,
): UseMutationResult<ProgramMembership, Error, RolePayload> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ membershipId, role }: RolePayload) => {
      const res = await apiClient.patch<ProgramMembership>(
        `/programs/${programId}/members/${membershipId}/`,
        { role },
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['program-members', programId] });
    },
  });
}

export function useRemoveProgramMember(
  programId: string,
): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (membershipId: string) => {
      await apiClient.delete(`/programs/${programId}/members/${membershipId}/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['program-members', programId] });
      void queryClient.invalidateQueries({ queryKey: ['programs', programId] });
      void queryClient.invalidateQueries({ queryKey: ['programs'] });
    },
  });
}
