import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { WorkspaceSettings } from '@/api/types';

/** Subset of WorkspaceSettings accepted by PATCH /workspace/. `subdomain` is omitted (read-only). */
export type WorkspaceSettingsPatch = Partial<Omit<WorkspaceSettings, 'subdomain'>>;

/** snake_case body sent to the API. */
interface WorkspaceSettingsPatchRaw {
  name?: string;
  timezone?: string;
  fiscal_year_start?: string;
  work_week?: boolean[];
  default_project_view?: string;
  allow_guests?: boolean;
  public_sharing?: boolean;
}

function toRaw(patch: WorkspaceSettingsPatch): WorkspaceSettingsPatchRaw {
  const raw: WorkspaceSettingsPatchRaw = {};
  if (patch.name !== undefined) raw.name = patch.name;
  if (patch.timezone !== undefined) raw.timezone = patch.timezone;
  if (patch.fiscalYearStart !== undefined) raw.fiscal_year_start = patch.fiscalYearStart;
  if (patch.workWeek !== undefined) raw.work_week = patch.workWeek;
  if (patch.defaultProjectView !== undefined) raw.default_project_view = patch.defaultProjectView;
  if (patch.allowGuests !== undefined) raw.allow_guests = patch.allowGuests;
  if (patch.publicSharing !== undefined) raw.public_sharing = patch.publicSharing;
  return raw;
}

export function useUpdateWorkspaceSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: WorkspaceSettingsPatch) => {
      const res = await apiClient.patch<WorkspaceSettings>('/workspace/', toRaw(patch));
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-settings'] });
    },
  });
}
