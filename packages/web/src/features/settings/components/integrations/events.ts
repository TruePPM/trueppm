/**
 * The real OSS webhook event catalog (#638, ADR-0083) — every event the backend
 * can fire, grouped for the event picker.
 *
 * This list MUST stay in step with `WebhookEventType` in
 * `packages/api/src/trueppm_api/apps/webhooks/models.py`. It went stale by eight
 * real events (the #1073 sprint trio and the #1082 risk/baseline/comment five,
 * both of which shipped backend-only) because nothing compared the two — the
 * Python gate and the TS build each passed in isolation (#2883). The gate now
 * exists: `test_web_event_catalog_covers_every_backend_event` in
 * `packages/api/tests/apps/webhooks/test_webhook_format.py` reads *this file* and
 * fails in both directions — a backend event with no entry here, and an entry here
 * the backend cannot emit.
 *
 * Adding an event is therefore two edits, and the pytest gate is what tells you
 * about the second one.
 *
 * `isNew` marks the most recently added cohort (the sprint / risk / baseline /
 * comment events). It is a "look here" badge, not a version claim — retire it from
 * a cohort once a later one lands.
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
      { id: 'task.assigned', label: 'Task assigned' },
      { id: 'task.assignee_changed', label: 'Task reassigned' },
      { id: 'task.mentioned', label: 'Mentioned in a comment' },
      { id: 'task.due_date_changed', label: 'Planned date changed' },
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
  {
    category: 'Sprint',
    events: [
      { id: 'sprint.activated', label: 'Sprint started', isNew: true },
      { id: 'sprint.closed', label: 'Sprint closed', isNew: true },
      { id: 'sprint.scope_changed', label: 'Scope accepted mid-sprint', isNew: true },
    ],
  },
  {
    category: 'Risk',
    events: [
      { id: 'risk.opened', label: 'Risk opened', isNew: true },
      { id: 'risk.escalated', label: 'Risk severity increased', isNew: true },
      { id: 'risk.closed', label: 'Risk closed', isNew: true },
    ],
  },
  {
    category: 'Baseline',
    events: [{ id: 'baseline.captured', label: 'Baseline captured', isNew: true }],
  },
  {
    category: 'Comment',
    events: [{ id: 'comment.created', label: 'Comment added', isNew: true }],
  },
];

/**
 * Flat list of every event id this build knows how to render.
 *
 * Used to *partition* a saved webhook's subscriptions into rendered and
 * unrendered — never to filter the unrendered ones away. See
 * `WebhookEditorModal`: narrowing a saved webhook to this list and PATCHing the
 * result silently deleted every subscription the picker had not caught up with.
 */
export const ALL_WEBHOOK_EVENT_IDS: string[] = WEBHOOK_EVENT_CATALOG.flatMap((g) =>
  g.events.map((e) => e.id),
);

export interface WebhookFormatDef {
  value: string;
  label: string;
  /** Only `slack` and `generic` ship in OSS; others are Enterprise. */
  available: boolean;
  hint: string;
}

export const WEBHOOK_FORMATS: WebhookFormatDef[] = [
  { value: 'generic', label: 'Generic (JSON)', available: true, hint: 'Raw event envelope.' },
  {
    value: 'slack',
    label: 'Slack',
    available: true,
    // NOT Block Kit — the renderer emits `text` + one legacy `attachments` entry,
    // which is exactly why it also works with Discord and Mattermost (#2885).
    // Claiming Block Kit set an expectation the payload does not meet.
    hint: 'Slack message with an attachment (also works with Discord & Mattermost).',
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
