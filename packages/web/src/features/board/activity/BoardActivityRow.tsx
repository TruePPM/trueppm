/**
 * One board-activity event row (ADR-0160, issue 1261).
 *
 * Renders as a button that opens the related card when the task is still on the board;
 * a deleted card (or one not in the loaded set) renders as a static row — there is no
 * drawer to open. Color tints are decorative — the verb phrase carries the meaning and
 * the row's aria-label restates the event for screen readers (rule 6).
 */

import { formatRelative } from '@/lib/formatRelative';
import { EVENT_META, type BoardActivityChange, type BoardActivityEvent } from './useBoardActivity';

/** Board-relevant field labels for the `task_updated` change summary. */
const FIELD_LABEL: Record<string, string> = {
  name: 'name',
  status: 'status',
  percent_complete: '% complete',
  story_points: 'points',
  remaining_points: 'remaining',
  assignee: 'assignee',
};

/** "status: To do → In progress" for one change; "… · +N more" when several changed. */
function summarize(changes: BoardActivityChange[]): string {
  if (changes.length === 0) return '';
  const [first, ...rest] = changes;
  const label = FIELD_LABEL[first.field] ?? first.field;
  const summary = `${label}: ${first.old ?? '—'} → ${first.new ?? '—'}`;
  return rest.length ? `${summary} · +${rest.length} more` : summary;
}

interface BoardActivityRowProps {
  event: BoardActivityEvent;
  /** Open the related card. Undefined → the task isn't openable (deleted / not loaded). */
  onOpen?: () => void;
}

export function BoardActivityRow({ event, onOpen }: BoardActivityRowProps) {
  const meta = EVENT_META[event.event_type];
  const actor = event.actor ?? 'System';
  const summary = event.event_type === 'task_updated' ? summarize(event.changes) : '';
  const when = formatRelative(new Date(event.timestamp));
  const label = `${actor} ${meta.verb} ${event.task_name}${summary ? `, ${summary}` : ''}, ${when}`;

  const body = (
    <>
      <span aria-hidden="true" className={`mt-0.5 w-4 shrink-0 text-center text-sm ${meta.tint}`}>
        {meta.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-xs">
            <span className="font-medium text-neutral-text-primary">{actor}</span>{' '}
            <span className="text-neutral-text-secondary">{meta.verb}</span>
          </span>
          <span
            className="shrink-0 text-xs text-neutral-text-secondary"
            title={new Date(event.timestamp).toISOString()}
          >
            {when}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-neutral-text-primary">
          {event.task_name}
          {onOpen === undefined && event.event_type === 'task_deleted' && (
            <span className="text-neutral-text-disabled"> (deleted)</span>
          )}
        </span>
        {summary && (
          <span className="tppm-mono mt-0.5 block truncate text-xs text-neutral-text-secondary">
            {summary}
          </span>
        )}
      </span>
    </>
  );

  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open card: ${label}`}
        className="flex min-h-11 w-full items-start gap-2 px-3 py-2 text-left hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
      >
        {body}
      </button>
    );
  }
  return (
    <div className="flex min-h-11 w-full items-start gap-2 px-3 py-2" aria-label={label}>
      {body}
    </div>
  );
}
