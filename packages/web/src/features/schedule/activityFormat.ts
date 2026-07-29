import type { TaskActivityEntry } from '@/hooks/useTaskHistory';

/**
 * Shared per-event copy for the task activity feed (#1883, #2315 slice 3).
 *
 * `summaryVerb` renders the terse "what happened" phrase after the actor name
 * ("changed duration", "recalculated the schedule", …). Extracted here so the
 * full `ActivityTimeline` (Activity tab) and the compact inline audit trail at
 * the top of the Details tab (`DrawerRecentActivity`) share ONE source and can
 * never drift on wording.
 */

/** Human labels for the fields a `fields_changed` diff can name. */
const FIELD_LABEL: Record<string, string> = {
  name: 'Name',
  duration: 'Duration',
  status: 'Status',
  percent_complete: 'Progress',
  planned_start: 'Start date',
  actual_start: 'Actual start',
  actual_finish: 'Actual finish',
  assignee: 'Assignee',
  sprint: 'Sprint',
  parent_epic: 'Epic',
  notes: 'Notes',
  color: 'Color',
  wbs_path: 'Outline position',
  is_milestone: 'Milestone',
  is_subtask: 'Subtask',
  is_recurring: 'Recurring',
  type: 'Type',
  dor: 'Definition of Ready',
  blocker_type: 'Blocker',
  blocked_by: 'Blocked by',
  blocking_task: 'Waiting on',
  story_points: 'Story points',
  remaining_points: 'Remaining points',
  optimistic_duration: 'Optimistic (O)',
  most_likely_duration: 'Most likely (M)',
  pessimistic_duration: 'Pessimistic (P)',
  estimate_status: 'Estimate status',
  priority_rank: 'Priority',
  governance_class: 'Governance',
  delivery_mode: 'Delivery mode',
  business_value: 'Business value',
  time_criticality: 'Time criticality',
  risk_reduction: 'Risk reduction',
  job_size: 'Job size',
  reach: 'Reach',
  impact: 'Impact',
  confidence: 'Confidence',
  value: 'Value',
  effort: 'Effort',
  effort_estimate: 'Effort estimate',
};

/** Display label for a diff field key (raw key when unmapped). */
export function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field;
}

/** A change record that conveys nothing the user can read — an empty `~` diff —
 *  is the bare "Updated" pill (issue 874). Filtered on every activity surface. */
export function isEmptyChange(entry: TaskActivityEntry): boolean {
  return entry.event_type === 'fields_changed' && (entry.diff?.length ?? 0) === 0;
}

/** Verb for a field-diff event: names the single changed field, or a count. */
export function changeVerb(entry: TaskActivityEntry): string {
  if (entry.event_type === 'task_created') return 'created this task';
  if (entry.event_type === 'task_deleted') return 'deleted this task';
  const diff = entry.diff ?? [];
  if (diff.length === 1) return `changed ${fieldLabel(diff[0].field).toLowerCase()}`;
  return `updated ${diff.length} fields`;
}

/** The summary verb rendered after the actor name. Field-diff verbs live in
 *  `changeVerb`; everything else is a fixed phrase (a couple vary on detail). */
export function summaryVerb(entry: TaskActivityEntry): string {
  const { event_type: et, detail } = entry;
  switch (et) {
    case 'task_created':
      return 'created this task';
    case 'task_deleted':
      return 'deleted this task';
    case 'fields_changed':
      return changeVerb(entry);
    case 'comment_added':
      return 'commented';
    case 'comment_edited':
      return 'edited a comment';
    case 'comment_deleted':
      return 'deleted a comment';
    case 'time_logged':
      return 'logged time';
    case 'time_deleted':
      return 'deleted a time entry';
    case 'attachment_uploaded':
      return detail.kind === 'url' ? 'attached a link' : 'attached a file';
    case 'attachment_deleted':
      return 'deleted an attachment';
    case 'cpm_recalculated':
      return 'recalculated the schedule';
    case 'baseline_drift_detected':
      return 'detected baseline drift';
    case 'risk_linked':
      return 'linked a risk';
    case 'risk_unlinked':
      return 'unlinked a risk';
    default:
      return et.replaceAll('_', ' ');
  }
}
