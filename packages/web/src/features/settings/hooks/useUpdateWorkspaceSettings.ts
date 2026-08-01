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
  feedback_enabled?: boolean;
  feedback_url?: string;
  iteration_label?: string;
  iteration_label_override_policy?: 'inherit' | 'suggest' | 'enforce';
  mc_history_enabled?: boolean;
  mc_history_retention_cap?: number;
  mc_history_attribution_audience?: MCAttributionAudience;
  mc_history_override_policy?: MCHistoryOverridePolicy;
  task_duration_change_percent_policy?: DurationChangePercentPolicy;
  task_duration_change_percent_override_policy?: 'inherit' | 'suggest' | 'enforce';
  estimation_scale?: EstimationScale;
  sprint_picker_ready_only_default?: boolean;
  methodology?: ProgramMethodology;
  methodology_override_policy?: MethodologyOverridePolicy;
  attachments_enabled?: boolean;
  allowed_attachment_types?: string[];
  attachments_override_policy?: 'inherit' | 'suggest' | 'enforce';
  calendar?: string | null;
  calendar_override_policy?: CalendarOverridePolicy;
}

/**
 * Each accepted camelCase patch key paired with its snake_case API field. Every
 * field is a plain passthrough — there is nothing per-field to branch on — so a
 * data table keeps {@link toRaw} a single flat copy loop instead of ~25 `if`
 * statements (issue #2356 cognitive-complexity pass). Add new PATCH-able fields
 * here, not as another `if`.
 */
const FIELD_MAP: ReadonlyArray<[keyof WorkspaceSettingsPatch, keyof WorkspaceSettingsPatchRaw]> = [
  ['name', 'name'],
  ['timezone', 'timezone'],
  ['fiscalYearStartMonth', 'fiscal_year_start_month'],
  ['fiscalYearStartDay', 'fiscal_year_start_day'],
  ['workWeek', 'work_week'],
  ['defaultProjectView', 'default_project_view'],
  ['allowGuests', 'allow_guests'],
  ['publicSharing', 'public_sharing'],
  ['publicSharingOverridePolicy', 'public_sharing_override_policy'],
  ['iterationLabel', 'iteration_label'],
  ['iterationLabelOverridePolicy', 'iteration_label_override_policy'],
  ['mcHistoryEnabled', 'mc_history_enabled'],
  ['mcHistoryRetentionCap', 'mc_history_retention_cap'],
  ['mcHistoryAttributionAudience', 'mc_history_attribution_audience'],
  ['mcHistoryOverridePolicy', 'mc_history_override_policy'],
  ['taskDurationChangePercentPolicy', 'task_duration_change_percent_policy'],
  ['taskDurationChangePercentOverridePolicy', 'task_duration_change_percent_override_policy'],
  ['estimationScale', 'estimation_scale'],
  ['sprintPickerReadyOnlyDefault', 'sprint_picker_ready_only_default'],
  ['methodology', 'methodology'],
  ['methodologyOverridePolicy', 'methodology_override_policy'],
  ['attachmentsEnabled', 'attachments_enabled'],
  ['allowedAttachmentTypes', 'allowed_attachment_types'],
  ['attachmentsOverridePolicy', 'attachments_override_policy'],
  ['calendar', 'calendar'],
  ['calendarOverridePolicy', 'calendar_override_policy'],
  ['feedbackEnabled', 'feedback_enabled'],
  ['feedbackUrl', 'feedback_url'],
];

function toRaw(patch: WorkspaceSettingsPatch): WorkspaceSettingsPatchRaw {
  const raw: WorkspaceSettingsPatchRaw = {};
  const out = raw as Record<string, unknown>;
  for (const [camelKey, snakeKey] of FIELD_MAP) {
    const value = patch[camelKey];
    // `undefined` means "field not being patched" (vs `null`, which clears the
    // override for nullable fields like `calendar`) — only skip the former.
    if (value !== undefined) out[snakeKey] = value;
  }
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
