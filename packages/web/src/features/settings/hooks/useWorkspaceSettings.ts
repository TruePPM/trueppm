import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { WorkspaceSettings } from '@/api/types';

// Re-export the type so existing call sites that import from this module keep
// working without changing their import path.
export type { WorkspaceSettings };

/** snake_case shape returned by GET /workspace/ */
interface WorkspaceSettingsRaw {
  name: string;
  subdomain: string;
  timezone: string;
  fiscal_year_start_month: number;
  fiscal_year_start_day: number;
  fiscal_year_start_display: string;
  work_week: boolean[];
  default_project_view: string;
  allow_guests: boolean;
  public_sharing: boolean;
  iteration_label: string;
  iteration_label_override_policy: 'inherit' | 'suggest' | 'enforce';
}

/** Maps snake_case wire shape to the camelCase interface consumed by pages. */
function mapSettings(raw: WorkspaceSettingsRaw): WorkspaceSettings {
  return {
    name: raw.name,
    subdomain: raw.subdomain,
    timezone: raw.timezone,
    fiscalYearStartMonth: raw.fiscal_year_start_month,
    fiscalYearStartDay: raw.fiscal_year_start_day,
    fiscalYearStartDisplay: raw.fiscal_year_start_display,
    workWeek: raw.work_week,
    defaultProjectView: raw.default_project_view,
    allowGuests: raw.allow_guests,
    publicSharing: raw.public_sharing,
    iterationLabel: raw.iteration_label,
    iterationLabelOverridePolicy: raw.iteration_label_override_policy,
  };
}

export function useWorkspaceSettings() {
  return useQuery({
    queryKey: ['workspace-settings'],
    queryFn: async () => {
      const res = await apiClient.get<WorkspaceSettingsRaw>('/workspace/');
      return mapSettings(res.data);
    },
  });
}
