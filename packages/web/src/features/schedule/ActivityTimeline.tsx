import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTaskHistory, type TaskHistoryRecord } from '@/hooks/useTaskHistory';
import { useTaskComments } from '@/hooks/useTaskComments';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import type { TaskComment } from '@/types';
import { EmptyState } from '@/components/EmptyState';
import { ListIcon } from '@/components/Icons';
import { formatRelative } from '@/lib/formatRelative';
import { fmtUtcShort } from '@/lib/formatUtcDate';

/**
 * Unified task Activity timeline (issue 869, ADR-0096 Part 2).
 *
 * Replaces the former split `HistoryTab` (field-diff cards) + `ActivityLog`
 * (semantic timeline) drawer sections with ONE chronological timeline that
 * merges two client-side feeds — the task history (`useTaskHistory`) and task
 * comments (`useTaskComments`) — sorted newest-first. A field-group filter
 * (Dates / Progress / Status / Assignment / Estimates / Description / Comments)
 * and a per-person filter let a PM slice to just the changes they care about.
 *
 * The separate Comments section still owns the threaded discussion; here a
 * comment is a read-only "commented" event. CPM recalculations never appear
 * (they write no history rows — ADR-0096 Finding B), so there is deliberately
 * no "System" group in v1.
 */

// ---------------------------------------------------------------------------
// Field → filter-group taxonomy (ADR-0096 Part 2)
// ---------------------------------------------------------------------------

type Group =
  | 'dates'
  | 'progress'
  | 'status'
  | 'assignment'
  | 'estimates'
  | 'description'
  | 'comments';

const GROUP_ORDER: Group[] = [
  'dates',
  'progress',
  'status',
  'assignment',
  'estimates',
  'description',
  'comments',
];

const GROUP_LABEL: Record<Group, string> = {
  dates: 'Dates',
  progress: 'Progress',
  status: 'Status',
  assignment: 'Assignment',
  estimates: 'Estimates',
  description: 'Description',
  comments: 'Comments',
};

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
// Unified event model (history record OR comment)
// ---------------------------------------------------------------------------

type UnifiedEvent =
  | {
      kind: 'change';
      key: string;
      ts: number;
      actor: string | null;
      record: TaskHistoryRecord;
      groups: Set<Group>;
    }
  | { kind: 'comment'; key: string; ts: number; actor: string; comment: TaskComment };

function groupsForRecord(record: TaskHistoryRecord): Set<Group> {
  const groups = new Set<Group>();
  for (const d of record.diff) {
    const g = FIELD_TO_GROUP[d.field];
    if (g) groups.add(g);
  }
  return groups;
}

/** A change record that conveys nothing the user can read — an empty `~` diff —
 *  is the bare "Updated" pill (issue 874). It is stripped server-side once ADR-0096
 *  Part 1 lands; this client guard keeps it out regardless of backend version. */
function isEmptyChange(e: UnifiedEvent): boolean {
  return e.kind === 'change' && e.record.history_type === '~' && e.record.diff.length === 0;
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

function DiffRows({ record }: { record: TaskHistoryRecord }) {
  return (
    <dl className="mt-1 flex flex-col gap-1">
      {record.diff.map((d) => (
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

function changeVerb(record: TaskHistoryRecord): string {
  if (record.history_type === '+') return 'created this task';
  if (record.history_type === '-') return 'deleted this task';
  if (record.diff.length === 1) return `changed ${fieldLabel(record.diff[0].field).toLowerCase()}`;
  return `updated ${record.diff.length} fields`;
}

function ActivityRow({ event, isLast }: { event: UnifiedEvent; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const date = new Date(event.ts);
  const isSystem = event.kind === 'change' && event.actor === null;
  const actorLabel = isSystem ? 'System' : (event.actor as string);

  // A multi-field change is collapsible; a single-field change shows inline; a
  // comment / creation / deletion has nothing more to reveal.
  const multiField = event.kind === 'change' && event.record.diff.length > 1;
  const singleField = event.kind === 'change' && event.record.diff.length === 1;

  const summary = event.kind === 'comment' ? 'commented' : changeVerb(event.record);

  return (
    <div className="flex gap-3">
      {/* Timeline rail */}
      <div className="flex w-7 shrink-0 flex-col items-center">
        <EventAvatar actor={event.actor} />
        {!isLast && (
          <div className="mt-1 min-h-4 w-px flex-1 bg-neutral-border/60" aria-hidden="true" />
        )}
      </div>

      {/* Content. No container aria-label: the summary line + diff rows / comment
          body read naturally (rule 171 — an aria-label here would be read AND the
          non-hidden descendants re-read in NVDA/JAWS). */}
      <div className="min-w-0 flex-1 pb-4">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 flex-1 text-xs text-neutral-text-primary">
            {isSystem ? (
              <span className="italic text-neutral-text-secondary">System</span>
            ) : (
              <span className="font-semibold">{actorLabel}</span>
            )}{' '}
            {summary}
          </p>
          <time
            dateTime={date.toISOString()}
            title={date.toLocaleString()}
            className="shrink-0 text-xs text-neutral-text-secondary tppm-mono"
          >
            {formatRelative(date)}
          </time>
          {multiField && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-label={expanded ? 'Hide changes' : 'Show changes'}
              className="shrink-0 rounded text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              <span aria-hidden="true" className="text-xs">
                {expanded ? '▴' : '▾'}
              </span>
            </button>
          )}
        </div>

        {/* Comment preview (read-only; the Comments section owns the thread) */}
        {event.kind === 'comment' && event.comment.body.trim() !== '' && (
          <p className="mt-0.5 line-clamp-1 text-xs text-neutral-text-secondary">
            {event.comment.body}
          </p>
        )}

        {/* Single-field change shows its diff inline; multi-field reveals on expand */}
        {singleField && <DiffRows record={event.record} />}
        {multiField && expanded && <DiffRows record={event.record} />}
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
            <div className="h-7 w-7 animate-pulse rounded-full bg-neutral-border" />
            {i < 2 && <div className="mt-1 min-h-4 w-px flex-1 bg-neutral-border/40" />}
          </div>
          <div className="flex-1 pb-4">
            <div className="flex justify-between gap-2">
              <div className="h-3 w-40 animate-pulse rounded bg-neutral-border" />
              <div className="h-3 w-12 shrink-0 animate-pulse rounded bg-neutral-border" />
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
  // Comments are a second, non-fatal feed: if they fail to load the timeline
  // still renders the history-only view (never crash the section).
  const { comments } = useTaskComments(projectId, taskId);

  const [group, setGroup] = useState<FilterKey>('all');
  const [person, setPerson] = useState<string | null>(null);

  const historyRecords = useMemo(() => data?.pages.flatMap((p) => p.results) ?? [], [data]);

  const events = useMemo<UnifiedEvent[]>(() => {
    const changeEvents: UnifiedEvent[] = historyRecords.map((record) => ({
      kind: 'change',
      key: `h-${record.id}`,
      ts: new Date(record.history_date).getTime(),
      actor: record.history_user,
      record,
      groups: groupsForRecord(record),
    }));
    const commentEvents: UnifiedEvent[] = comments
      .filter((c) => !c.is_deleted)
      .map((c) => ({
        kind: 'comment',
        key: `c-${c.id}`,
        ts: new Date(c.created_at).getTime(),
        actor: c.author?.display_name ?? c.author?.username ?? 'Someone',
        comment: c,
      }));
    return [...changeEvents, ...commentEvents]
      .filter((e) => !isEmptyChange(e))
      .sort((a, b) => b.ts - a.ts);
  }, [historyRecords, comments]);

  // Filter chips: only groups actually present in the data (plus All).
  const chips = useMemo<{ key: FilterKey; label: string }[]>(() => {
    const present = new Set<Group>();
    for (const e of events) {
      if (e.kind === 'comment') present.add('comments');
      else e.groups.forEach((g) => present.add(g));
    }
    return [
      { key: 'all' as FilterKey, label: `All · ${events.length}` },
      ...GROUP_ORDER.filter((g) => present.has(g)).map((g) => ({
        key: g as FilterKey,
        label: GROUP_LABEL[g],
      })),
    ];
  }, [events]);

  // Distinct actors for the per-person filter (this task only — rule: no cross-task).
  const persons = useMemo(() => {
    const set = new Set<string>();
    for (const e of events) if (e.actor) set.add(e.actor);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [events]);

  // A chip/person that no longer exists after a refetch falls back gracefully.
  const effectiveGroup = chips.some((c) => c.key === group) ? group : 'all';
  const effectivePerson = person !== null && persons.includes(person) ? person : null;

  const filtered = useMemo(
    () =>
      events.filter((e) => {
        if (effectivePerson !== null && e.actor !== effectivePerson) return false;
        if (effectiveGroup === 'all') return true;
        if (e.kind === 'comment') return effectiveGroup === 'comments';
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

  const isUnfiltered = effectiveGroup === 'all' && effectivePerson === null;

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
              className="h-7 rounded-md border border-neutral-border bg-neutral-surface px-2 text-xs text-neutral-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              <option value="">Anyone</option>
              {persons.map((p) => (
                <option key={p} value={p}>
                  {p}
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
            <ActivityRow key={event.key} event={event} isLast={i === filtered.length - 1} />
          ))}
        </div>
      )}

      {/* Load more — only on the unfiltered view (pagination over the full feed) */}
      {isUnfiltered && hasNextPage && (
        <button
          type="button"
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
          className="h-9 w-full rounded border border-neutral-border text-xs font-medium text-neutral-text-secondary hover:border-brand-primary hover:text-neutral-text-primary disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
