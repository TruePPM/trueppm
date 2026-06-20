import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type {
  MCAttributionAudience,
  MCHistoryOverridePolicy,
  WorkspaceSettings,
} from '@/api/types';

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
  mc_history_enabled: boolean;
  mc_history_retention_cap: number;
  mc_history_attribution_audience: MCAttributionAudience;
  mc_history_override_policy: MCHistoryOverridePolicy;
  logo_url: string | null;
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
    mcHistoryEnabled: raw.mc_history_enabled,
    mcHistoryRetentionCap: raw.mc_history_retention_cap,
    mcHistoryAttributionAudience: raw.mc_history_attribution_audience,
    mcHistoryOverridePolicy: raw.mc_history_override_policy,
    logoUrl: raw.logo_url,
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
