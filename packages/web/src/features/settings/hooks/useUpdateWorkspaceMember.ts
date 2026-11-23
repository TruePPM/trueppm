import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

interface UpdateMemberPayload {
  userId: string;
  role?: number;
  status?: string;
  /** Availability baseline fields (#542); a key's presence, not truthiness, drives the PATCH. */
  availabilityPercent?: number;
  availabilityEffectiveFrom?: string | null;
  availabilityEffectiveTo?: string | null;
  availabilityNotes?: string;
}

export function useUpdateWorkspaceMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, role, status, ...availability }: UpdateMemberPayload) => {
      const body: Record<string, unknown> = {};
      if (role !== undefined) body.role = role;
      if (status !== undefined) body.status = status;
      if (availability.availabilityPercent !== undefined)
        body.availability_percent = availability.availabilityPercent;
      if (availability.availabilityEffectiveFrom !== undefined)
        body.availability_effective_from = availability.availabilityEffectiveFrom;
      if (availability.availabilityEffectiveTo !== undefined)
        body.availability_effective_to = availability.availabilityEffectiveTo;
      if (availability.availabilityNotes !== undefined)
        body.availability_notes = availability.availabilityNotes;
      const res = await apiClient.patch(`/workspace/members/${userId}/`, body);
      return res.data as unknown;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-members'] });
    },
  });
}

export function useRemoveWorkspaceMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      await apiClient.delete(`/workspace/members/${userId}/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-members'] });
    },
  });
}
