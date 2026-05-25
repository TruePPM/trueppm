/**
 * The real OSS webhook event catalog (#638, ADR-0083) — exactly the 11 events
 * the backend can fire, grouped for the event picker. The four added in 0.2 are
 * tagged `isNew`. Do NOT add events here that WebhookEventType can't emit; the
 * picker must stay truthful to the backend's 11-event hard cap.
 */

export interface WebhookEventDef {
  id: string;
  label: string;
  isNew?: boolean;
}

export interface WebhookEventGroup {
  category: string;
  events: WebhookEventDef[];
}

export const WEBHOOK_EVENT_CATALOG: WebhookEventGroup[] = [
  {
    category: 'Task',
    events: [
      { id: 'task.created', label: 'Task created' },
      { id: 'task.updated', label: 'Task updated' },
      { id: 'task.deleted', label: 'Task deleted' },
      { id: 'task.assigned', label: 'Task assigned', isNew: true },
      { id: 'task.assignee_changed', label: 'Task reassigned', isNew: true },
      { id: 'task.mentioned', label: 'Mentioned in a comment', isNew: true },
      { id: 'task.due_date_changed', label: 'Planned date changed', isNew: true },
    ],
  },
  {
    category: 'Dependency',
    events: [
      { id: 'dependency.created', label: 'Dependency added' },
      { id: 'dependency.deleted', label: 'Dependency removed' },
    ],
  },
  {
    category: 'Schedule',
    events: [{ id: 'schedule.recalculated', label: 'Schedule recalculated' }],
  },
  {
    category: 'Project',
    events: [{ id: 'project.created', label: 'Project created' }],
  },
];

/** Flat set of every valid event id — used to filter unknown ids defensively. */
export const ALL_WEBHOOK_EVENT_IDS: string[] = WEBHOOK_EVENT_CATALOG.flatMap((g) =>
  g.events.map((e) => e.id),
);

export interface WebhookFormatDef {
  value: string;
  label: string;
  /** Only `slack` and `generic` ship in OSS 0.2; others are Enterprise. */
  available: boolean;
  hint: string;
}

export const WEBHOOK_FORMATS: WebhookFormatDef[] = [
  { value: 'generic', label: 'Generic (JSON)', available: true, hint: 'Raw event envelope.' },
  {
    value: 'slack',
    label: 'Slack',
    available: true,
    hint: 'Slack Block-Kit message (also works with Discord & Mattermost).',
  },
  { value: 'discord', label: 'Discord', available: false, hint: 'Enterprise.' },
  { value: 'pagerduty', label: 'PagerDuty', available: false, hint: 'Enterprise.' },
];

/** Human label for an event id (falls back to the id). */
export function eventLabel(id: string): string {
  for (const group of WEBHOOK_EVENT_CATALOG) {
    const found = group.events.find((e) => e.id === id);
    if (found) return found.label;
  }
  return id;
}
