/**
 * Workspace > System Health > Dead-letter inspector.
 *
 * Split-view: left list of failed tasks with filter controls + a bulk action bar,
 * right detail pane with exception info, payload viewer, and per-task write
 * actions. Selected task id lives in the URL as ?selected={id} so links are
 * shareable.
 *
 * Write actions (#695, ADR-0210): requeue-with-backoff and drop-with-note, single
 * and bulk-over-the-current-filter. Requeue round-trips through the durable
 * workflow backend server-side; drop soft-removes (→ dismissed) but retains the
 * row for audit. All actions are workspace-admin gated server-side.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button } from '@/components/Button';
import { toast } from '@/components/Toast';
import {
  useFailedTask,
  useFailedTasks,
  type FailedTaskFilters,
  type FailedTaskStatus,
} from '@/hooks/useFailedTasks';
import {
  useDropAllFailedTasks,
  useDropFailedTask,
  useRequeueAllFailedTasks,
  useRequeueFailedTask,
} from '@/hooks/useFailedTaskActions';
import { DeadLetterActionDialog, type DeadLetterActionKind } from './DeadLetterActionDialog';
import { formatAge } from './formatAge';

/** Statuses an operator can requeue (matches the server's actionable set). */
const REQUEUEABLE_STATUSES: ReadonlySet<FailedTaskStatus> = new Set<FailedTaskStatus>([
  'dead',
  'pending_retry',
]);

/** Extract a human-readable error message from an axios-style mutation error. */
function actionErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const resp = (err as { response?: { data?: { detail?: unknown } } }).response;
    const detail = resp?.data?.detail;
    if (typeof detail === 'string') return detail;
  }
  return 'Action failed — please try again.';
}

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
  const requeueMut = useRequeueFailedTask();
  const dropMut = useDropFailedTask();
  const [action, setAction] = useState<DeadLetterActionKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const closeDialog = useCallback(() => {
    setAction(null);
    setActionError(null);
  }, []);

  const handleConfirm = useCallback(
    ({ backoffSeconds, note }: { backoffSeconds: number; note: string }) => {
      if (!data) return;
      setActionError(null);
      // onError sets the inline dialog alert AND a toast: the inline alert covers
      // the dialog-open case; the toast is the fallback if the operator dismissed
      // the dialog while the mutation was still in flight (the alert would be gone).
      const onError = (err: unknown) => {
        const message = actionErrorMessage(err);
        setActionError(message);
        toast.error(message);
      };
      if (action === 'requeue') {
        requeueMut.mutate(
          { id: data.id, backoffSeconds },
          {
            onSuccess: () => {
              closeDialog();
              toast.success(`Requeued ${data.task_name}.`);
            },
            onError,
          },
        );
      } else if (action === 'drop') {
        dropMut.mutate(
          { id: data.id, note },
          {
            onSuccess: () => {
              closeDialog();
              toast.success(`Dropped ${data.task_name}.`);
            },
            onError,
          },
        );
      }
    },
    [action, data, requeueMut, dropMut, closeDialog],
  );

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

  const canRequeue = REQUEUEABLE_STATUSES.has(data.status);
  const canDrop = data.status !== 'dismissed';
  const busy = requeueMut.isPending || dropMut.isPending;

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

        {/* Per-task write actions (ADR-0210). Hidden once terminal. */}
        {(canRequeue || canDrop) && (
          <div className="mt-3 flex items-center gap-2">
            {canRequeue && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => setAction('requeue')}
                disabled={busy}
              >
                Requeue
              </Button>
            )}
            {canDrop && (
              <Button variant="danger" size="sm" onClick={() => setAction('drop')} disabled={busy}>
                Drop
              </Button>
            )}
          </div>
        )}

        {/* Operator-action audit — shown once resolved. */}
        {data.resolved_at && (
          <p className="mt-2 text-[11px] text-neutral-text-secondary">
            {data.status === 'dismissed' ? 'Dropped' : 'Requeued'}
            {data.resolved_by_display ? ` by ${data.resolved_by_display}` : ''} ·{' '}
            {new Date(data.resolved_at).toLocaleString()}
            {data.resolution_note ? ` — “${data.resolution_note}”` : ''}
          </p>
        )}
      </div>

      {action && (
        <DeadLetterActionDialog
          kind={action}
          taskName={data.task_name}
          busy={busy}
          error={actionError}
          onCancel={closeDialog}
          onConfirm={handleConfirm}
        />
      )}

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

  // Memoized so the bulk-action callbacks (and the query key) get a stable
  // reference — otherwise a fresh object every render churns their deps.
  const filters: FailedTaskFilters = useMemo(
    () => ({
      status: statusFilter || undefined,
      task_name: debouncedTaskName || undefined,
      failed_after: windowToIso(timeWindow) || undefined,
    }),
    [statusFilter, debouncedTaskName, timeWindow],
  );

  const { data, isLoading, error } = useFailedTasks(filters);
  const tasks = data?.results ?? [];

  // Bulk actions over the current filter set (ADR-0210 §4). Bounded server-side.
  const requeueAllMut = useRequeueAllFailedTasks();
  const dropAllMut = useDropAllFailedTasks();
  const [bulkAction, setBulkAction] = useState<DeadLetterActionKind | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const bulkBusy = requeueAllMut.isPending || dropAllMut.isPending;

  // Per-verb bulk-action gating (rule 227): requeue-all can only act on the
  // actionable statuses, so it is a dead affordance under a terminal-only filter
  // (dismissed/retried); drop-all is a no-op when everything shown is already
  // dismissed. "All statuses" ('') keeps both — the server acts on the subset and
  // the confirm copy + result toast report the true count.
  const canBulkRequeue = statusFilter === '' || REQUEUEABLE_STATUSES.has(statusFilter);
  const canBulkDrop = statusFilter !== 'dismissed';

  const closeBulk = useCallback(() => {
    setBulkAction(null);
    setBulkError(null);
  }, []);

  const bulkResultToast = useCallback((verb: string, result: { processed: number; capped: boolean }) => {
    const suffix = result.capped ? ' (batch capped — repeat to continue)' : '';
    toast.success(`${verb} ${result.processed} task${result.processed === 1 ? '' : 's'}.${suffix}`);
  }, []);

  const handleBulkConfirm = useCallback(
    ({ backoffSeconds, note }: { backoffSeconds: number; note: string }) => {
      setBulkError(null);
      // Inline alert + toast fallback, as with the single actions — an Escape
      // mid-flight would otherwise swallow a bulk error silently.
      const onError = (err: unknown) => {
        const message = actionErrorMessage(err);
        setBulkError(message);
        toast.error(message);
      };
      if (bulkAction === 'requeue') {
        requeueAllMut.mutate(
          { filters, backoffSeconds },
          {
            onSuccess: (result) => {
              closeBulk();
              bulkResultToast('Requeued', result);
            },
            onError,
          },
        );
      } else if (bulkAction === 'drop') {
        dropAllMut.mutate(
          { filters, note },
          {
            onSuccess: (result) => {
              closeBulk();
              bulkResultToast('Dropped', result);
            },
            onError,
          },
        );
      }
    },
    [bulkAction, filters, requeueAllMut, dropAllMut, closeBulk, bulkResultToast],
  );

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
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] text-neutral-text-secondary">
              {data.count} task{data.count !== 1 ? 's' : ''}
            </span>
            {/* Each bulk button is gated to the statuses it can actually act on
                (web-rule 219): requeue only touches dead/pending_retry, drop skips
                already-dismissed. Hiding the no-op affordance on a terminal-only
                filter keeps the (N) honest rather than promising N and doing 0. */}
            {data.count > 0 && canBulkRequeue && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setBulkAction('requeue')}
                disabled={bulkBusy}
              >
                Requeue all ({data.count})
              </Button>
            )}
            {data.count > 0 && canBulkDrop && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setBulkAction('drop')}
                disabled={bulkBusy}
              >
                Drop all ({data.count})
              </Button>
            )}
          </div>
        )}
      </div>

      {bulkAction && data && (
        <DeadLetterActionDialog
          kind={bulkAction}
          bulkCount={data.count}
          busy={bulkBusy}
          error={bulkError}
          onCancel={closeBulk}
          onConfirm={handleBulkConfirm}
        />
      )}

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
