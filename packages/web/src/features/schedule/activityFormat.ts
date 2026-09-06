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

/**
 * Human labels for the fields a history diff can name.
 *
 * One map for every history surface (#3435): the task drawer's Activity tab, the
 * project Activity page (`ProjectActivityPage`), and anything else that renders a
 * server field diff. The server keys every diff row by model **field name**
 * (`assignee`, never `assignee_id`) precisely so this map can be the only one —
 * the project page used to print `c.field` raw because it had no map of its own.
 * Curated entries name the change rather than the column (`Outline position`, not
 * `wbs_path`); anything unmapped falls through to `humanizeField`, so a newly
 * tracked field is at worst rendered as prose, never as an identifier.
 */
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
  // #3306. The server surfaces this bit only when it is a record's ONLY change — a
  // cascade onto a subtree already at the requested governance class, which breaks
  // the root's inheritance and moves nothing else. "Governance source" rather than
  // the column name: what changed is where the task's governance comes from, not a
  // boolean the planner has ever seen named.
  parent_governance_inherited: 'Governance source',
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
  planned_finish: 'Finish date',
  // A soft delete is a `~` row whose only change is this flag; the project Activity
  // page keeps it so the delete has a record (the drawer hides it — a deleted task
  // has no drawer). "Deleted", so the row reads "updated Task · Deleted".
  is_deleted: 'Deleted',
  // Non-task sources of the project Activity page whose humanized column would
  // mislead or read as jargon.
  dep_type: 'Dependency type',
  wip_limit: 'WIP limit',
  mcp_enabled: 'MCP access',
  mc_history_enabled: 'Monte Carlo history',
  mc_history_retention_cap: 'Monte Carlo history retention',
  mc_history_attribution_audience: 'Monte Carlo history attribution',
  lead: 'Project lead',
  code: 'Project code',
};

/**
 * Fallback for a field with no curated label: `goal_outcome` → "Goal outcome".
 * Sentence case (first word only) because labels sit mid-sentence in
 * `changeVerb` ("changed governance class") and lower-casing a Title Case label
 * would also flatten the acronyms the curated entries protect.
 */
export function humanizeField(field: string): string {
  const words = field.replaceAll('_', ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : field;
}

/** Display label for a diff field key — curated when known, humanized otherwise. */
export function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? humanizeField(field);
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
