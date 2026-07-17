import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type {
  CalendarOverridePolicy,
  DurationChangePercentPolicy,
  MCAttributionAudience,
  MCHistoryOverridePolicy,
  MethodologyOverridePolicy,
  ProgramMethodology,
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
  public_sharing_override_policy: 'inherit' | 'suggest' | 'enforce';
  iteration_label: string;
  iteration_label_override_policy: 'inherit' | 'suggest' | 'enforce';
  mc_history_enabled: boolean;
  mc_history_retention_cap: number;
  mc_history_attribution_audience: MCAttributionAudience;
  mc_history_override_policy: MCHistoryOverridePolicy;
  task_duration_change_percent_policy: DurationChangePercentPolicy;
  task_duration_change_percent_override_policy: 'inherit' | 'suggest' | 'enforce';
  methodology: ProgramMethodology;
  methodology_override_policy: MethodologyOverridePolicy;
  attachments_enabled: boolean;
  allowed_attachment_types: string[];
  attachments_override_policy: 'inherit' | 'suggest' | 'enforce';
  calendar: string | null;
  calendar_override_policy: CalendarOverridePolicy;
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
    publicSharingOverridePolicy: raw.public_sharing_override_policy,
    iterationLabel: raw.iteration_label,
    iterationLabelOverridePolicy: raw.iteration_label_override_policy,
    mcHistoryEnabled: raw.mc_history_enabled,
    mcHistoryRetentionCap: raw.mc_history_retention_cap,
    mcHistoryAttributionAudience: raw.mc_history_attribution_audience,
    mcHistoryOverridePolicy: raw.mc_history_override_policy,
    taskDurationChangePercentPolicy: raw.task_duration_change_percent_policy,
    taskDurationChangePercentOverridePolicy: raw.task_duration_change_percent_override_policy,
    methodology: raw.methodology,
    methodologyOverridePolicy: raw.methodology_override_policy,
    attachmentsEnabled: raw.attachments_enabled,
    allowedAttachmentTypes: raw.allowed_attachment_types,
    attachmentsOverridePolicy: raw.attachments_override_policy,
    calendar: raw.calendar,
    calendarOverridePolicy: raw.calendar_override_policy,
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
