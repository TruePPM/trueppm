import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { useTaskHistory, type TaskActivityEntry } from '@/hooks/useTaskHistory';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import { EmptyState } from '@/components/EmptyState';
import { ListIcon } from '@/components/Icons';
import { formatRelative } from '@/lib/formatRelative';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { useUserDateFormat } from '@/hooks/useUserDateFormat';

/**
 * Unified task Activity timeline (issue 869, ADR-0096 Part 2; extended #1883).
 *
 * ONE chronological timeline over the server's merged activity feed
 * (`?include=comments,time,attachments,schedule,risks`, ADR-0207). Before #1883
 * this component called the plain `/history/` field-diff feed and merged comments
 * client-side, so schedule/risk/time/attachment events — and the full comment
 * lifecycle (edited/deleted) — were written by the backend but read by nobody.
 * It now renders every event type from the single feed; the client-side comment
 * merge is gone (the server emits `comment_added`/`comment_edited`/`comment_deleted`
 * directly, which is what fixes the missing "· edited" marker and vanishing
 * deleted comments).
 *
 * A type-group filter (Dates / Progress / Status / Assignment / Estimates /
 * Description / Comments / Schedule / Risks / Time / Attachments) and a per-person
 * filter let a PM slice to just the events they care about. System events
 * (CPM recalcs, baseline drift) render under the "System" actor treatment.
 */

// ---------------------------------------------------------------------------
// Filter-group taxonomy (ADR-0096 Part 2; Schedule/Risks/Time/Attachments #1883)
// ---------------------------------------------------------------------------

type Group =
  | 'dates'
  | 'progress'
  | 'status'
  | 'assignment'
  | 'estimates'
  | 'description'
  | 'comments'
  | 'schedule'
  | 'risks'
  | 'time'
  | 'attachments';

const GROUP_ORDER: Group[] = [
  'dates',
  'progress',
  'status',
  'assignment',
  'estimates',
  'description',
  'comments',
  'schedule',
  'risks',
  'time',
  'attachments',
];

const GROUP_LABEL: Record<Group, string> = {
  dates: 'Dates',
  progress: 'Progress',
  status: 'Status',
  assignment: 'Assignment',
  estimates: 'Estimates',
  description: 'Description',
  comments: 'Comments',
  schedule: 'Schedule',
  risks: 'Risks',
  time: 'Time',
  attachments: 'Attachments',
};

// Non-field event types → their single filter group. Field-diff events
// (task_created/fields_changed/task_deleted) derive groups from FIELD_TO_GROUP.
const EVENT_GROUP: Record<string, Group> = {
  comment_added: 'comments',
  comment_edited: 'comments',
  comment_deleted: 'comments',
  cpm_recalculated: 'schedule',
  baseline_drift_detected: 'schedule',
  risk_linked: 'risks',
  risk_unlinked: 'risks',
  time_logged: 'time',
  time_deleted: 'time',
  attachment_uploaded: 'attachments',
  attachment_deleted: 'attachments',
};

const FIELD_DIFF_TYPES = new Set(['task_created', 'fields_changed', 'task_deleted']);

/** Maps a history diff field name to its filter group. Fields with no entry are
 *  still shown under "All" — they simply match no group chip. */
const FIELD_TO_GROUP: Record<string, Group> = {
  planned_start: 'dates',
  actual_start: 'dates',
  actual_finish: 'dates',
  percent_complete: 'progress',
  status: 'status',
  dor: 'status',
  assignee: 'assignment',
  sprint: 'assignment',
  parent_epic: 'assignment',
  blocked_by: 'assignment',
  blocking_task: 'assignment',
  blocker_type: 'assignment',
  duration: 'estimates',
  optimistic_duration: 'estimates',
  most_likely_duration: 'estimates',
  pessimistic_duration: 'estimates',
  estimate_status: 'estimates',
  priority_rank: 'estimates',
  story_points: 'estimates',
  remaining_points: 'estimates',
  business_value: 'estimates',
  time_criticality: 'estimates',
  risk_reduction: 'estimates',
  job_size: 'estimates',
  reach: 'estimates',
  impact: 'estimates',
  confidence: 'estimates',
  effort: 'estimates',
  value: 'estimates',
  effort_estimate: 'estimates',
  name: 'description',
  notes: 'description',
  color: 'description',
  wbs_path: 'description',
  type: 'description',
  is_milestone: 'description',
  is_subtask: 'description',
  is_recurring: 'description',
  governance_class: 'description',
  delivery_mode: 'description',
};

// ---------------------------------------------------------------------------
// Field labels + value formatting
// ---------------------------------------------------------------------------

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

const STATUS_LABELS: Record<string, string> = {
  BACKLOG: 'Backlog',
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  REVIEW: 'Review',
  ON_HOLD: 'On hold',
  COMPLETE: 'Complete',
};

const DATE_FIELDS = new Set(['planned_start', 'actual_start', 'actual_finish']);

function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field;
}

function fmtValue(field: string, val: string | null): string {
  if (val == null) return '—';
  if (field === 'status') return STATUS_LABELS[val] ?? val;
  if (field === 'percent_complete') {
    const n = Number(val);
    return Number.isFinite(n) ? `${Math.round(n)}%` : val;
  }
  if (DATE_FIELDS.has(field)) return fmtUtcShort(val);
  return val;
}

// ---------------------------------------------------------------------------
// Unified event model — one shape over every merged-feed event_type (#1883)
// ---------------------------------------------------------------------------

/**
 * A single timeline event derived from one merged-feed entry.
 * - `actorKey` — stable person identity (`actor.id`) used to dedupe and filter
 *   by person; `null` for system/authorless events (excluded from the filter).
 * - `actor` — the label rendered in the row (`actor.display_name`); `null` renders
 *   as "System".
 * - `groups` — filter groups this event matches (a field-diff event can match
 *   several; every other event type matches exactly one).
 */
interface TimelineEvent {
  key: string;
  ts: number;
  actorKey: string | null;
  actor: string | null;
  groups: Set<Group>;
  entry: TaskActivityEntry;
}

/**
 * Guarantee the two fields every downstream reader depends on (`event_type`,
 * `timestamp`). The merged feed always supplies both, but a legacy field-diff
 * payload (an older cache, or a test/mock that returns the pre-#1883 shape) may
 * not — and a missing `event_type` would otherwise crash `summaryVerb` and tear
 * down the whole drawer via the error boundary. Infer from the legacy keys.
 */
function normalize(entry: TaskActivityEntry): TaskActivityEntry {
  if (entry.event_type && entry.timestamp) return entry;
  const inferred =
    entry.history_type === '+'
      ? 'task_created'
      : entry.history_type === '-'
        ? 'task_deleted'
        : 'fields_changed';
  return {
    ...entry,
    event_type: entry.event_type ?? inferred,
    timestamp: entry.timestamp ?? entry.history_date ?? new Date(0).toISOString(),
    actor:
      entry.actor ??
      (entry.history_user
        ? { id: entry.history_user, display_name: entry.history_user_display ?? entry.history_user }
        : null),
  };
}

function groupsFor(entry: TaskActivityEntry): Set<Group> {
  if (FIELD_DIFF_TYPES.has(entry.event_type)) {
    const groups = new Set<Group>();
    for (const d of entry.diff ?? []) {
      const g = FIELD_TO_GROUP[d.field];
      if (g) groups.add(g);
    }
    return groups;
  }
  const g = EVENT_GROUP[entry.event_type];
  return g ? new Set<Group>([g]) : new Set<Group>();
}

/** A change record that conveys nothing the user can read — an empty `~` diff —
 *  is the bare "Updated" pill (issue 874). Guarded here regardless of backend version. */
function isEmptyChange(entry: TaskActivityEntry): boolean {
  return entry.event_type === 'fields_changed' && (entry.diff?.length ?? 0) === 0;
}

// A per-entry-type stable id inside the detail payload, so React keys don't
// collide when two events share a timestamp (e.g. add + edit of one comment).
const DETAIL_ID_KEYS = [
  'comment_id',
  'time_entry_id',
  'attachment_id',
  'risk_id',
  'baseline_id',
] as const;

function eventKey(entry: TaskActivityEntry, idx: number): string {
  if (entry.id != null) return `h-${entry.id}`;
  const detailId = DETAIL_ID_KEYS.map((k) => entry.detail[k]).find(
    (v) => typeof v === 'string' || typeof v === 'number',
  );
  return `${entry.event_type}-${entry.timestamp}-${detailId ?? idx}`;
}

// ---------------------------------------------------------------------------
// Per-event-type copy (terse verb + optional secondary detail line, #1883)
// ---------------------------------------------------------------------------

function str(detail: Record<string, unknown>, key: string): string | null {
  const v = detail[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function num(detail: Record<string, unknown>, key: string): number | null {
  const v = detail[key];
  return typeof v === 'number' ? v : null;
}

/** Nested `{from, to}` date deltas the CPM event carries; we surface the `to`. */
function nestedTo(detail: Record<string, unknown>, key: string): string | null {
  const v = detail[key];
  if (v && typeof v === 'object' && 'to' in v) {
    const to = (v as { to: unknown }).to;
    return typeof to === 'string' ? to : null;
  }
  return null;
}

function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** The summary verb rendered after the actor name. Field-diff verbs live in
 *  `changeVerb`; everything else is a fixed phrase (a couple vary on detail). */
function summaryVerb(entry: TaskActivityEntry): string {
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
      return et.replace(/_/g, ' ');
  }
}

/** Optional muted secondary line under the summary (preview, label, delta). */
function detailLine(entry: TaskActivityEntry): string | null {
  const { event_type: et, detail } = entry;
  switch (et) {
    case 'comment_added':
    case 'comment_edited':
      return str(detail, 'preview');
    case 'time_logged':
    case 'time_deleted': {
      const min = num(detail, 'minutes');
      const on = str(detail, 'entry_date');
      if (min == null) return null;
      return on ? `${fmtMinutes(min)} on ${fmtUtcShort(on)}` : fmtMinutes(min);
    }
    case 'attachment_uploaded':
    case 'attachment_deleted':
      return str(detail, 'label');
    case 'cpm_recalculated': {
      // #1948: newer rows carry a per-project recalc summary (how many tasks
      // moved + where finish landed). Legacy pre-#1948 rows lack
      // `recalc_moved_count` → keep the original single-task Finish line.
      const moved = num(detail, 'recalc_moved_count');
      if (moved == null) {
        const finish = nestedTo(detail, 'early_finish');
        const parts = [];
        if (finish) parts.push(`Finish ${fmtUtcShort(finish)}`);
        if (detail.is_critical === true) parts.push('on the critical path');
        return parts.length ? parts.join(' · ') : null;
      }
      const parts = [`${moved} ${moved === 1 ? 'task' : 'tasks'} moved`];
      const delta = num(detail, 'recalc_finish_delta_days');
      if (delta != null) {
        // ASCII sign per web-rule 120 (no Unicode +/− glyphs in copy).
        if (delta === 0) parts.push('finish unchanged');
        else parts.push(`finish ${delta > 0 ? '+' : '-'}${Math.abs(delta)}d`);
      }
      return parts.join(' · ');
    }
    case 'baseline_drift_detected': {
      const drift = num(detail, 'drift_days');
      return drift != null ? `${drift}d behind baseline` : null;
    }
    case 'risk_linked':
    case 'risk_unlinked': {
      const shortId = str(detail, 'risk_short_id');
      const title = str(detail, 'risk_title');
      return [shortId, title].filter(Boolean).join(' · ') || null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Group filter — accessible radiogroup, roving tabindex (web-rule 167)
// ---------------------------------------------------------------------------

type FilterKey = 'all' | Group;

function GroupFilter({
  chips,
  value,
  onChange,
}: {
  chips: { key: FilterKey; label: string }[];
  value: FilterKey;
  onChange: (key: FilterKey) => void;
}) {
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIdx = chips.findIndex((c) => c.key === value);
  const [focusIdx, setFocusIdx] = useState(selectedIdx >= 0 ? selectedIdx : 0);
  useEffect(() => {
    if (selectedIdx >= 0) setFocusIdx(selectedIdx);
  }, [selectedIdx]);

  function moveFocus(next: number) {
    const i = Math.max(0, Math.min(chips.length - 1, next));
    setFocusIdx(i);
    btnRefs.current[i]?.focus(); // focus only — commit happens on activation (rule 167)
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        moveFocus(focusIdx + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        moveFocus(focusIdx - 1);
        break;
      case 'Home':
        e.preventDefault();
        moveFocus(0);
        break;
      case 'End':
        e.preventDefault();
        moveFocus(chips.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Filter activity by type"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-wrap gap-1.5"
    >
      {chips.map(({ key, label }, i) => {
        const active = key === value;
        return (
          <button
            key={key}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={i === focusIdx ? 0 : -1}
            onClick={() => onChange(key)}
            className={[
              'h-7 rounded-full border px-3 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
              active
                ? 'border-transparent bg-brand-primary text-neutral-text-inverse'
                : 'border-neutral-border bg-neutral-surface text-neutral-text-secondary hover:bg-neutral-surface-raised hover:text-neutral-text-primary',
            ].join(' ')}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Avatar / system dot (decorative — rule 6, accessible name lives in the row text)
// ---------------------------------------------------------------------------

function EventAvatar({ actor }: { actor: string | null }) {
  if (actor === null) {
    return (
      <div className="flex h-7 w-7 shrink-0 items-center justify-center" aria-hidden="true">
        <div className="h-2.5 w-2.5 rounded-full bg-neutral-text-secondary/50" />
      </div>
    );
  }
  return (
    <div
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-brand-primary/30 bg-brand-primary/10"
      aria-hidden="true"
    >
      <span className="text-xs font-semibold leading-none text-brand-primary">
        {actor.charAt(0).toUpperCase()}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diff rows (revealed on expand, or shown inline for a single-field change)
// ---------------------------------------------------------------------------

function DiffRows({ entry }: { entry: TaskActivityEntry }) {
  return (
    <dl className="mt-1 flex flex-col gap-1">
      {(entry.diff ?? []).map((d) => (
        <div key={d.field} className="flex items-baseline gap-1 text-xs">
          <dt className="w-28 shrink-0 truncate text-neutral-text-secondary">
            {fieldLabel(d.field)}
          </dt>
          <dd className="flex min-w-0 items-baseline gap-1 text-neutral-text-primary tppm-mono">
            {d.old != null && (
              <>
                <span className="max-w-[90px] truncate text-neutral-text-secondary line-through">
                  {fmtValue(d.field, d.old)}
                </span>
                <span className="text-neutral-text-secondary" aria-hidden="true">
                  →
                </span>
              </>
            )}
            <span className="max-w-[120px] truncate font-medium">{fmtValue(d.field, d.new)}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Single timeline row
// ---------------------------------------------------------------------------

function changeVerb(entry: TaskActivityEntry): string {
  if (entry.event_type === 'task_created') return 'created this task';
  if (entry.event_type === 'task_deleted') return 'deleted this task';
  const diff = entry.diff ?? [];
  if (diff.length === 1) return `changed ${fieldLabel(diff[0].field).toLowerCase()}`;
  return `updated ${diff.length} fields`;
}

function ActivityRow({
  event,
  isLast,
  projectId,
}: {
  event: TimelineEvent;
  isLast: boolean;
  projectId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // Activity timestamps are INSTANTS (#1953, ADR-0410) — re-clock the relative
  // fallback + the full-date tooltip to the viewer's timezone + format.
  const { prefs, formatInstant } = useUserDateFormat();
  const { entry } = event;
  const date = new Date(event.ts);
  const isSystem = event.actor === null;
  const actorLabel = isSystem ? 'System' : (event.actor as string);

  // Only field-diff changes carry a diff to reveal; a multi-field change is
  // collapsible, a single-field change shows inline, everything else is a
  // one-line event.
  const diffLen = FIELD_DIFF_TYPES.has(entry.event_type) ? (entry.diff?.length ?? 0) : 0;
  const multiField = diffLen > 1;
  const singleField = diffLen === 1;
  const secondary = detailLine(entry);

  return (
    <div className="flex gap-3">
      {/* Timeline rail */}
      <div className="flex w-7 shrink-0 flex-col items-center">
        <EventAvatar actor={event.actor} />
        {!isLast && (
          <div className="mt-1 min-h-4 w-px flex-1 bg-neutral-border/60" aria-hidden="true" />
        )}
      </div>

      {/* Content. No container aria-label: the summary line + diff rows / detail
          line read naturally (rule 171 — an aria-label here would be read AND the
          non-hidden descendants re-read in NVDA/JAWS). */}
      <div className="min-w-0 flex-1 pb-4">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 flex-1 text-xs text-neutral-text-primary">
            {isSystem ? (
              <span className="italic text-neutral-text-secondary">System</span>
            ) : (
              <span className="font-semibold">{actorLabel}</span>
            )}{' '}
            {summaryVerb(entry)}
          </p>
          <time
            dateTime={date.toISOString()}
            title={formatInstant(date.toISOString())}
            className="shrink-0 text-xs text-neutral-text-secondary tppm-mono"
          >
            {formatRelative(date, undefined, prefs)}
          </time>
          {multiField && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-label={expanded ? 'Hide changes' : 'Show changes'}
              className="shrink-0 rounded-control text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              <span aria-hidden="true" className="text-xs">
                {expanded ? '▴' : '▾'}
              </span>
            </button>
          )}
        </div>

        {/* Secondary detail line (comment preview, attachment label, risk title,
            logged duration, schedule delta) — muted, single-line. */}
        {secondary != null && secondary.trim() !== '' && (
          // title exposes the full value: risk titles, filenames, and comment
          // previews can exceed one line and clamp silently otherwise (web-rule:
          // a clamped line must never be the only place a value appears).
          <p title={secondary} className="mt-0.5 line-clamp-1 text-xs text-neutral-text-secondary">
            {secondary}
          </p>
        )}

        {/* A CPM recalc names what moved but can't link the individual tasks
            (the row carries no per-task correlation id, #1948) — so offer a
            jump to the schedule where the shift is visible in context. */}
        {entry.event_type === 'cpm_recalculated' && (
          <Link
            to={`/projects/${projectId}/schedule`}
            className="mt-0.5 inline-block rounded text-xs text-brand-primary hover:text-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            View in schedule{' '}
            <span aria-hidden="true">→</span>
          </Link>
        )}

        {/* Single-field change shows its diff inline; multi-field reveals on expand */}
        {singleField && <DiffRows entry={entry} />}
        {multiField && expanded && <DiffRows entry={entry} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function ActivitySkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true" aria-label="Loading activity">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-3">
          <div className="flex w-7 shrink-0 flex-col items-center">
            <div className="h-7 w-7 motion-safe:animate-pulse rounded-full bg-neutral-border" />
            {i < 2 && <div className="mt-1 min-h-4 w-px flex-1 bg-neutral-border/40" />}
          </div>
          <div className="flex-1 pb-4">
            <div className="flex justify-between gap-2">
              <div className="h-3 w-40 motion-safe:animate-pulse rounded-chip bg-neutral-border" />
              <div className="h-3 w-12 shrink-0 motion-safe:animate-pulse rounded-chip bg-neutral-border" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public section component
// ---------------------------------------------------------------------------

export function ActivityTimeline({ projectId, taskId }: DrawerSectionProps) {
  const {
    data,
    isLoading: historyLoading,
    error: historyError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useTaskHistory(projectId, taskId);

  const [group, setGroup] = useState<FilterKey>('all');
  const [person, setPerson] = useState<string | null>(null);

  const entries = useMemo(() => data?.pages.flatMap((p) => p.results) ?? [], [data]);

  // One event per merged-feed entry. The feed is already newest-first from the
  // server; we re-sort defensively so pages appended out of order stay ordered.
  const events = useMemo<TimelineEvent[]>(() => {
    return entries
      .map(normalize)
      .filter((entry) => !isEmptyChange(entry))
      .map((entry, i) => ({
        key: eventKey(entry, i),
        ts: new Date(entry.timestamp).getTime(),
        actorKey: entry.actor?.id ?? null,
        actor: entry.actor?.display_name ?? null,
        groups: groupsFor(entry),
        entry,
      }))
      .sort((a, b) => b.ts - a.ts);
  }, [entries]);

  // Filter chips: only groups actually present in the data (plus All).
  const chips = useMemo<{ key: FilterKey; label: string }[]>(() => {
    const present = new Set<Group>();
    for (const e of events) e.groups.forEach((g) => present.add(g));
    return [
      { key: 'all' as FilterKey, label: `All · ${events.length}` },
      ...GROUP_ORDER.filter((g) => present.has(g)).map((g) => ({
        key: g as FilterKey,
        label: GROUP_LABEL[g],
      })),
    ];
  }, [events]);

  // Distinct actors for the per-person filter (this task only — rule: no cross-task).
  // Deduped by actorKey (actor.id) so the same human across event sources is ONE
  // entry (#1878); system/authorless events (null actorKey) are excluded.
  const persons = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const e of events) {
      if (!e.actorKey) continue;
      if (!byKey.has(e.actorKey)) byKey.set(e.actorKey, e.actor ?? e.actorKey);
    }
    return [...byKey.entries()]
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [events]);

  // A chip/person that no longer exists after a refetch falls back gracefully.
  const effectiveGroup = chips.some((c) => c.key === group) ? group : 'all';
  const effectivePerson = person !== null && persons.some((p) => p.key === person) ? person : null;

  const filtered = useMemo(
    () =>
      events.filter((e) => {
        if (effectivePerson !== null && e.actorKey !== effectivePerson) return false;
        if (effectiveGroup === 'all') return true;
        return e.groups.has(effectiveGroup);
      }),
    [events, effectiveGroup, effectivePerson],
  );

  if (historyLoading) return <ActivitySkeleton />;

  if (historyError) {
    return (
      <p className="py-6 text-center text-xs text-semantic-critical" role="alert">
        Couldn&apos;t load activity. Try reopening the task.
      </p>
    );
  }

  if (events.length === 0) {
    return (
      <EmptyState
        icon={ListIcon}
        title="No activity yet"
        description="Changes and comments on this task will appear here as they happen."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Filters */}
      <div className="flex flex-col gap-2">
        <GroupFilter chips={chips} value={effectiveGroup} onChange={setGroup} />
        {persons.length > 1 && (
          <div className="flex items-center gap-2">
            <label htmlFor="activity-person-filter" className="sr-only">
              Filter activity by person
            </label>
            <select
              id="activity-person-filter"
              value={effectivePerson ?? ''}
              onChange={(e) => setPerson(e.target.value === '' ? null : e.target.value)}
              className="h-7 rounded-control border border-neutral-border bg-neutral-surface px-2 text-xs text-neutral-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              <option value="">Anyone</option>
              {persons.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Result count for assistive tech */}
      <p className="sr-only" role="status" aria-live="polite">
        {filtered.length} of {events.length} activity events shown
      </p>

      {/* Timeline */}
      {filtered.length === 0 ? (
        <p className="py-8 text-center text-xs text-neutral-text-secondary" role="status">
          No matching activity.
        </p>
      ) : (
        <div className="flex flex-col">
          {filtered.map((event, i) => (
            <ActivityRow
              key={event.key}
              event={event}
              isLast={i === filtered.length - 1}
              projectId={projectId}
            />
          ))}
        </div>
      )}

      {hasNextPage && (
        <button
          type="button"
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
          className="h-9 w-full rounded-control border border-neutral-border text-xs font-medium text-neutral-text-secondary hover:border-brand-primary hover:text-neutral-text-primary disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
