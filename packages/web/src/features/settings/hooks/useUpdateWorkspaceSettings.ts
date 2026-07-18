import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type {
  CalendarOverridePolicy,
  DurationChangePercentPolicy,
  EstimationScale,
  MCAttributionAudience,
  MCHistoryOverridePolicy,
  MethodologyOverridePolicy,
  ProgramMethodology,
  WorkspaceSettings,
} from '@/api/types';

/**
 * Subset of WorkspaceSettings accepted by PATCH /workspace/. `subdomain`,
 * `fiscalYearStartDisplay`, and `logoUrl` are omitted (all read-only; the logo
 * is mutated via the dedicated /workspace/logo/ endpoint, not this PATCH).
 */
export type WorkspaceSettingsPatch = Partial<
  Omit<WorkspaceSettings, 'subdomain' | 'fiscalYearStartDisplay' | 'logoUrl'>
>;

/** snake_case body sent to the API. `fiscal_year_start_display` is read-only. */
interface WorkspaceSettingsPatchRaw {
  name?: string;
  timezone?: string;
  fiscal_year_start_month?: number;
  fiscal_year_start_day?: number;
  work_week?: boolean[];
  default_project_view?: string;
  allow_guests?: boolean;
  public_sharing?: boolean;
  public_sharing_override_policy?: 'inherit' | 'suggest' | 'enforce';
  iteration_label?: string;
  iteration_label_override_policy?: 'inherit' | 'suggest' | 'enforce';
  mc_history_enabled?: boolean;
  mc_history_retention_cap?: number;
  mc_history_attribution_audience?: MCAttributionAudience;
  mc_history_override_policy?: MCHistoryOverridePolicy;
  task_duration_change_percent_policy?: DurationChangePercentPolicy;
  task_duration_change_percent_override_policy?: 'inherit' | 'suggest' | 'enforce';
  estimation_scale?: EstimationScale;
  methodology?: ProgramMethodology;
  methodology_override_policy?: MethodologyOverridePolicy;
  attachments_enabled?: boolean;
  allowed_attachment_types?: string[];
  attachments_override_policy?: 'inherit' | 'suggest' | 'enforce';
  calendar?: string | null;
  calendar_override_policy?: CalendarOverridePolicy;
}

function toRaw(patch: WorkspaceSettingsPatch): WorkspaceSettingsPatchRaw {
  const raw: WorkspaceSettingsPatchRaw = {};
  if (patch.name !== undefined) raw.name = patch.name;
  if (patch.timezone !== undefined) raw.timezone = patch.timezone;
  if (patch.fiscalYearStartMonth !== undefined)
    raw.fiscal_year_start_month = patch.fiscalYearStartMonth;
  if (patch.fiscalYearStartDay !== undefined) raw.fiscal_year_start_day = patch.fiscalYearStartDay;
  if (patch.workWeek !== undefined) raw.work_week = patch.workWeek;
  if (patch.defaultProjectView !== undefined) raw.default_project_view = patch.defaultProjectView;
  if (patch.allowGuests !== undefined) raw.allow_guests = patch.allowGuests;
  if (patch.publicSharing !== undefined) raw.public_sharing = patch.publicSharing;
  if (patch.publicSharingOverridePolicy !== undefined)
    raw.public_sharing_override_policy = patch.publicSharingOverridePolicy;
  if (patch.iterationLabel !== undefined) raw.iteration_label = patch.iterationLabel;
  if (patch.iterationLabelOverridePolicy !== undefined)
    raw.iteration_label_override_policy = patch.iterationLabelOverridePolicy;
  if (patch.mcHistoryEnabled !== undefined) raw.mc_history_enabled = patch.mcHistoryEnabled;
  if (patch.mcHistoryRetentionCap !== undefined)
    raw.mc_history_retention_cap = patch.mcHistoryRetentionCap;
  if (patch.mcHistoryAttributionAudience !== undefined)
    raw.mc_history_attribution_audience = patch.mcHistoryAttributionAudience;
  if (patch.mcHistoryOverridePolicy !== undefined)
    raw.mc_history_override_policy = patch.mcHistoryOverridePolicy;
  if (patch.taskDurationChangePercentPolicy !== undefined)
    raw.task_duration_change_percent_policy = patch.taskDurationChangePercentPolicy;
  if (patch.taskDurationChangePercentOverridePolicy !== undefined)
    raw.task_duration_change_percent_override_policy = patch.taskDurationChangePercentOverridePolicy;
  if (patch.estimationScale !== undefined) raw.estimation_scale = patch.estimationScale;
  if (patch.methodology !== undefined) raw.methodology = patch.methodology;
  if (patch.methodologyOverridePolicy !== undefined)
    raw.methodology_override_policy = patch.methodologyOverridePolicy;
  if (patch.attachmentsEnabled !== undefined)
    raw.attachments_enabled = patch.attachmentsEnabled;
  if (patch.allowedAttachmentTypes !== undefined)
    raw.allowed_attachment_types = patch.allowedAttachmentTypes;
  if (patch.attachmentsOverridePolicy !== undefined)
    raw.attachments_override_policy = patch.attachmentsOverridePolicy;
  if (patch.calendar !== undefined) raw.calendar = patch.calendar;
  if (patch.calendarOverridePolicy !== undefined)
    raw.calendar_override_policy = patch.calendarOverridePolicy;
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
