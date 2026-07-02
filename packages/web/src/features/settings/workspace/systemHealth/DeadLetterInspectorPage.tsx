/**
 * Workspace > System Health > Dead-letter inspector.
 *
 * Read-only split-view: left list of failed tasks with filter controls, right
 * detail pane with exception info and payload viewer. Selected task id lives
 * in the URL as ?selected={id} so links are shareable.
 *
 * NO retry/dismiss/requeue/drop actions — this surface is purely diagnostic.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  useFailedTask,
  useFailedTasks,
  type FailedTaskFilters,
  type FailedTaskStatus,
} from '@/hooks/useFailedTasks';
import { formatAge } from './formatAge';

// ---------------------------------------------------------------------------
// Small inline SVG icons
// ---------------------------------------------------------------------------

function ChevronLeftIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <polyline
        points="15 18 9 12 15 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="shrink-0 text-neutral-text-disabled"
    >
      <polyline
        points="9 18 15 12 9 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="text-semantic-on-track"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <polyline
        points="9 12 11 14 15 10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const STATUS_DOT_CLASS: Record<FailedTaskStatus, string> = {
  dead: 'bg-semantic-critical',
  pending_retry: 'bg-semantic-at-risk',
  dismissed: 'bg-neutral-text-disabled',
  retried: 'bg-neutral-text-disabled',
};

const STATUS_LABEL: Record<FailedTaskStatus, string> = {
  dead: 'Dead',
  pending_retry: 'Pending retry',
  dismissed: 'Dismissed',
  retried: 'Retried',
};

const STATUS_PILL_CLASS: Record<FailedTaskStatus, string> = {
  // rule 8b: badge fills use the pre-computed -bg tokens, never the /N opacity
  // modifier (which diverges from the dark-mode RGBA in globals.css).
  dead: 'bg-semantic-critical-bg text-semantic-critical border border-semantic-critical/80',
  pending_retry: 'bg-semantic-at-risk-bg text-semantic-at-risk border border-semantic-at-risk/80',
  dismissed: 'bg-neutral-surface-sunken text-neutral-text-secondary',
  retried: 'bg-neutral-surface-sunken text-neutral-text-secondary',
};

function StatusPill({ status }: { status: FailedTaskStatus }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-chip text-[11px] font-semibold ${STATUS_PILL_CLASS[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Relative age — converts an ISO timestamp to "N ago"
// ---------------------------------------------------------------------------

function relativeAge(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  return formatAge(Math.max(0, Math.floor(seconds))) + ' ago';
}

// ---------------------------------------------------------------------------
// Debounce hook
// ---------------------------------------------------------------------------

function useDebounce<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debouncedValue;
}

// ---------------------------------------------------------------------------
// Time-window helper — returns ISO string for failed_after given a window key
// ---------------------------------------------------------------------------

type TimeWindow = '' | '1h' | '24h' | '7d';

function windowToIso(window: TimeWindow): string {
  if (!window) return '';
  const now = Date.now();
  const offsets: Record<string, number> = { '1h': 3600, '24h': 86400, '7d': 604800 };
  const offsetMs = (offsets[window] ?? 0) * 1000;
  return new Date(now - offsetMs).toISOString();
}

// ---------------------------------------------------------------------------
// List row
// ---------------------------------------------------------------------------

function TaskListRow({
  task,
  selected,
  onClick,
}: {
  task: {
    id: string;
    task_name: string;
    task_id: string;
    failure_count: number;
    last_failed_at: string;
    status: FailedTaskStatus;
  };
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'w-full text-left flex items-center gap-2.5 px-3.5 py-2.5 border-b border-neutral-border/55 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary',
        selected ? 'bg-brand-primary/8' : 'hover:bg-neutral-surface-raised',
      ].join(' ')}
      aria-current={selected ? 'true' : undefined}
    >
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT_CLASS[task.status]}`}
        aria-label={STATUS_LABEL[task.status]}
        role="img"
      />
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] font-medium text-neutral-text-primary truncate">
          {task.task_name}
        </span>
        <span className="flex items-center gap-2 mt-0.5">
          <span className="tppm-mono text-[11px] text-neutral-text-secondary truncate max-w-[120px]">
            {task.task_id.slice(0, 8)}…
          </span>
          <span className="text-[11px] text-neutral-text-secondary">×{task.failure_count}</span>
          <span className="text-[11px] text-neutral-text-secondary ml-auto shrink-0">
            {relativeAge(task.last_failed_at)}
          </span>
        </span>
      </span>
      <ChevronRightIcon />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Skeleton list rows
// ---------------------------------------------------------------------------

function ListSkeleton() {
  return (
    <div aria-label="Loading tasks" aria-busy="true">
      {[1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className="flex items-center gap-3 px-3.5 py-2.5 border-b border-neutral-border/55 motion-safe:animate-pulse"
        >
          <span className="w-2 h-2 rounded-full bg-neutral-surface-raised shrink-0" />
          <span className="flex-1">
            <span className="block h-3.5 w-2/3 rounded-chip bg-neutral-surface-raised" />
            <span className="block mt-1.5 h-2.5 w-1/2 rounded-chip bg-neutral-surface-raised" />
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail pane
// ---------------------------------------------------------------------------

function DetailPane({ id }: { id: string }) {
  const { data, isLoading, error } = useFailedTask(id);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-[13px] text-neutral-text-secondary motion-safe:animate-pulse">
        Loading…
      </div>
    );
  }

  if (error !== null || !data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-[13px] text-semantic-critical">Failed to load task details.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-5">
      {/* Header */}
      <div>
        <div className="flex items-start gap-2 flex-wrap">
          <h2 className="text-[16px] font-bold text-neutral-text-primary break-all">
            {data.task_name}
          </h2>
          <StatusPill status={data.status} />
        </div>
        <p className="mt-1 tppm-mono text-[11px] text-neutral-text-secondary break-all">
          {data.task_id}
        </p>
        <p className="mt-0.5 text-[11px] text-neutral-text-secondary">
          first {new Date(data.first_failed_at).toLocaleString()} · last{' '}
          {new Date(data.last_failed_at).toLocaleString()}
        </p>
      </div>

      {/* Attempt summary */}
      <div className="rounded-card border border-neutral-border overflow-hidden">
        <div className="px-4 py-2.5 bg-neutral-surface-sunken border-b border-neutral-border/55">
          <h3 className="text-[11px] font-semibold tracking-[.06em] uppercase text-neutral-text-secondary">
            Attempt summary
          </h3>
        </div>
        <div className="px-4 py-3 space-y-1.5">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="text-neutral-text-secondary w-36 shrink-0">Failure count</span>
            <span className="font-semibold tppm-mono text-neutral-text-primary">
              {data.failure_count}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[13px]">
            <span className="text-neutral-text-secondary w-36 shrink-0">First failed</span>
            <span className="text-neutral-text-primary">
              {new Date(data.first_failed_at).toLocaleString()}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[13px]">
            <span className="text-neutral-text-secondary w-36 shrink-0">Last failed</span>
            <span className="text-neutral-text-primary">
              {new Date(data.last_failed_at).toLocaleString()}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[13px]">
            <span className="text-neutral-text-secondary w-36 shrink-0">Exception type</span>
            <span className="tppm-mono text-neutral-text-primary">{data.exception_type}</span>
          </div>
          <p className="mt-2 text-[11px] text-neutral-text-secondary italic">
            Summary — per-attempt history is not recorded.
          </p>
        </div>
      </div>

      {/* Last error */}
      <div className="rounded-card border border-neutral-border overflow-hidden">
        <div className="px-4 py-2.5 bg-neutral-surface-sunken border-b border-neutral-border/55">
          <h3 className="text-[11px] font-semibold tracking-[.06em] uppercase text-neutral-text-secondary">
            Last error
          </h3>
        </div>
        <div className="px-4 py-3 space-y-2">
          <p className="text-[13px] font-semibold tppm-mono text-semantic-critical">
            {data.exception_type}
          </p>
          <p className="text-[12px] text-neutral-text-primary">{data.exception_message}</p>
          {data.traceback && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[12px] text-brand-primary font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-control">
                Traceback
              </summary>
              <pre className="mt-2 p-3 rounded-card border border-neutral-border bg-neutral-surface-sunken text-[11px] font-mono text-neutral-text-secondary overflow-auto max-h-[40vh] whitespace-pre-wrap break-all">
                {data.traceback}
              </pre>
            </details>
          )}
        </div>
      </div>

      {/* Payload viewer */}
      <div className="rounded-card border border-neutral-border overflow-hidden">
        <div className="px-4 py-2.5 bg-neutral-surface-sunken border-b border-neutral-border/55">
          <h3 className="text-[11px] font-semibold tracking-[.06em] uppercase text-neutral-text-secondary">
            Payload
          </h3>
        </div>
        <div className="p-3">
          <pre className="font-mono text-[11px] text-neutral-text-secondary bg-neutral-surface-sunken rounded-card border border-neutral-border p-3 overflow-auto max-h-[40vh] whitespace-pre-wrap break-all">
            {JSON.stringify({ args: data.args, kwargs: data.kwargs }, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

const SELECT_CLASS =
  'h-7 pl-2.5 pr-7 rounded-control border border-neutral-border text-[12px] text-neutral-text-secondary hover:text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 bg-neutral-surface-raised appearance-none bg-no-repeat bg-[right_0.45rem_center]';

const SELECT_STYLE = {
  backgroundImage:
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='9' height='9' viewBox='0 0 16 16'><path d='M4 6l4 4 4-4' stroke='%23667085' stroke-width='2' stroke-linecap='round' fill='none' /></svg>\")",
};

/**
 * Dead-letter inspector — split-view list/detail for failed background tasks.
 *
 * Selected task id is URL-persisted as ?selected={id}. Filters are local
 * state only (they reset on navigation); they are not URL-persisted to keep
 * shareable links focused on the selected task rather than the full filter
 * combination.
 */
export function DeadLetterInspectorPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('selected');

  // Filter state — task_name input is debounced to avoid a query per keystroke.
  const [statusFilter, setStatusFilter] = useState<FailedTaskStatus | ''>('');
  const [taskNameInput, setTaskNameInput] = useState('');
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('');
  const debouncedTaskName = useDebounce(taskNameInput, 300);

  const filters: FailedTaskFilters = {
    status: statusFilter || undefined,
    task_name: debouncedTaskName || undefined,
    failed_after: windowToIso(timeWindow) || undefined,
  };

  const { data, isLoading, error } = useFailedTasks(filters);
  const tasks = data?.results ?? [];

  const handleSelectTask = useCallback(
    (id: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('selected', id);
          return next;
        },
        { replace: false },
      );
    },
    [setSearchParams],
  );

  const handleClearSelection = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('selected');
        return next;
      },
      { replace: false },
    );
  }, [setSearchParams]);

  const statusSelectId = useId();
  const taskNameInputId = useId();
  const timeWindowSelectId = useId();

  // Scroll the selected row into view on mount / selection change.
  const selectedRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Breadcrumb */}
      <div className="px-6 pt-4 pb-2 flex items-center gap-1.5 shrink-0">
        <Link
          to="/settings/health"
          className="inline-flex items-center gap-1 text-[13px] text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-control"
        >
          <ChevronLeftIcon />
          System health
        </Link>
        <span className="text-neutral-text-disabled text-[13px]">/</span>
        <span className="text-[13px] text-neutral-text-primary font-medium">
          Dead-letter inspector
        </span>
      </div>

      {/* Filter row */}
      <div className="px-6 py-2.5 flex items-center gap-2 border-b border-neutral-border/55 flex-wrap shrink-0">
        <label htmlFor={statusSelectId} className="sr-only">
          Filter by status
        </label>
        <select
          id={statusSelectId}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as FailedTaskStatus | '')}
          className={SELECT_CLASS}
          style={SELECT_STYLE}
        >
          <option value="">All statuses</option>
          <option value="dead">Dead</option>
          <option value="pending_retry">Pending retry</option>
          <option value="dismissed">Dismissed</option>
          <option value="retried">Retried</option>
        </select>

        <label htmlFor={taskNameInputId} className="sr-only">
          Search by task name
        </label>
        <div className="flex items-center gap-2 h-7 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] w-[220px] focus-within:ring-2 focus-within:ring-brand-primary focus-within:border-brand-primary">
          <svg
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            className="text-neutral-text-disabled shrink-0"
          >
            <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            id={taskNameInputId}
            type="search"
            value={taskNameInput}
            onChange={(e) => setTaskNameInput(e.target.value)}
            placeholder="Task name…"
            className="flex-1 bg-transparent outline-none text-[12px] text-neutral-text-primary placeholder:text-neutral-text-disabled min-w-0"
          />
        </div>

        <label htmlFor={timeWindowSelectId} className="sr-only">
          Filter by time window
        </label>
        <select
          id={timeWindowSelectId}
          value={timeWindow}
          onChange={(e) => setTimeWindow(e.target.value as TimeWindow)}
          className={SELECT_CLASS}
          style={SELECT_STYLE}
        >
          <option value="">Any time</option>
          <option value="1h">Last 1h</option>
          <option value="24h">Last 24h</option>
          <option value="7d">Last 7 days</option>
        </select>

        {data && (
          <span className="ml-auto text-[11px] text-neutral-text-secondary">
            {data.count} task{data.count !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Split-view body */}
      <div className="flex flex-1 min-h-0">
        {/* Left list — on < md it's hidden once a task is selected (CSS, not JS width). */}
        <div
          className={`${selectedId ? 'hidden md:flex' : 'flex'} w-full md:w-[380px] md:shrink-0 flex-col border-r border-neutral-border overflow-hidden`}
        >
          <div className="flex-1 overflow-y-auto">
            {isLoading && <ListSkeleton />}

            {!isLoading && error !== null && (
              <div className="px-4 py-6 text-center">
                <p className="text-[13px] text-semantic-critical">Failed to load tasks.</p>
              </div>
            )}

            {!isLoading && !error && tasks.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 gap-3 px-4 text-center">
                <CheckCircleIcon />
                <p className="text-[13px] font-medium text-neutral-text-primary">
                  No dead-lettered tasks
                </p>
                <p className="text-[12px] text-neutral-text-secondary">
                  Background processing is clean.
                </p>
              </div>
            )}

            {!isLoading &&
              !error &&
              tasks.map((task) => (
                <div key={task.id} ref={task.id === selectedId ? selectedRowRef : undefined}>
                  <TaskListRow
                    task={task}
                    selected={task.id === selectedId}
                    onClick={() => handleSelectTask(task.id)}
                  />
                </div>
              ))}
          </div>
        </div>

        {/* Right detail — hidden on < md until a task is selected. */}
        <div className={`${selectedId ? 'flex' : 'hidden md:flex'} flex-1 min-w-0 flex-col`}>
          {/* On mobile, show a back button when detail is open */}
          {selectedId && (
            <div className="md:hidden px-4 pt-3 pb-2 shrink-0 border-b border-neutral-border/55">
              <button
                type="button"
                onClick={handleClearSelection}
                className="inline-flex items-center gap-1 text-[13px] text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-control"
              >
                <ChevronLeftIcon />
                Back to list
              </button>
            </div>
          )}

          {selectedId ? (
            <DetailPane id={selectedId} />
          ) : (
            <div className="flex-1 flex items-center justify-center text-[13px] text-neutral-text-secondary">
              {tasks.length > 0 ? 'Select a task to inspect.' : ''}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
