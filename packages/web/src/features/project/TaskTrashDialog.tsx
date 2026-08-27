import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { CloseIcon, InboxIcon } from '@/components/Icons';
import { QueryErrorState } from '@/components/QueryErrorState';
import { toast } from '@/components/Toast';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useRestoreTask, useTrashedTasks, type TrashedTask } from '@/hooks/useTaskMutations';
import { restoreRefusalMessage } from '@/hooks/restoreRefusal';

interface TaskTrashDialogProps {
  projectId: string;
  onClose: () => void;
}

/**
 * "Recently deleted" — the durable task recovery surface (#2494, ADR-0689).
 *
 * #2078 shipped a faithful `POST /tasks/:id/restore/` but left it reachable only from
 * the "Deleted — Undo" toast; dismiss the toast or reload and nothing in the product
 * admitted the task still existed. This lists the same membership-scoped tombstones the
 * restore endpoint resolves against, opened from the Schedule (···) and Board (⋯ More)
 * menus so recovery lives where the delete happened.
 *
 * Rows are restore *roots*: the server folds a tombstoned `is_subtask` subtree into its
 * ancestor and reports `subtree_count`, because one delete should read as one
 * recoverable item. `can_restore` is the server's own delete-parity predicate, so the
 * button's enablement cannot drift from the gate the POST enforces — the disabled state
 * is a render gate over an authoritative answer, not a guess.
 */
export function TaskTrashDialog({ projectId, onClose }: TaskTrashDialogProps) {
  const { data, isLoading, isError, refetch } = useTrashedTasks(projectId);
  const restore = useRestoreTask(projectId);
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose);

  const rows = data?.results ?? [];

  function handleRestore(task: TrashedTask) {
    if (!navigator.onLine) {
      toast.info("You're offline — reconnect to restore a task.");
      return;
    }
    restore.mutate(task.id, {
      onSuccess: () => toast.success(`"${task.name}" restored`),
      onError: (error) =>
        // "try again" is wrong for a 409: the position is occupied until somebody
        // moves the task holding it, and the server's detail names which one (#3071).
        toast.error(restoreRefusalMessage(error) ?? "Couldn't restore that task — try again."),
    });
  }

  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="task-trash-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-overlay p-4 focus:outline-none motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-[560px] flex-col rounded-lg border border-neutral-border bg-neutral-surface shadow-pop motion-safe:animate-modal-scale-in"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-neutral-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="task-trash-title" className="text-base font-semibold text-neutral-text-primary">
              Recently deleted
            </h2>
            <p className="mt-0.5 text-xs text-neutral-text-secondary">
              Tasks deleted from this project, and how long each stays restorable.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close recently deleted"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-surface-sunken hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            <CloseIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]">
          {isLoading ? (
            <ul className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <li
                  key={i}
                  className="h-[56px] animate-pulse rounded-card border border-neutral-border bg-neutral-surface-sunken"
                />
              ))}
            </ul>
          ) : isError ? (
            <QueryErrorState
              variant="inline"
              message="Couldn't load recently deleted tasks."
              onRetry={() => void refetch()}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={InboxIcon}
              title="Nothing deleted recently"
              description="Deleted tasks appear here and stay restorable until the retention window closes. Other item types — labels, risks, baselines — are not recoverable once deleted."
            />
          ) : (
            <>
              <ul className="flex flex-col gap-2">
                {rows.map((task) => (
                  <TrashRow
                    key={task.id}
                    task={task}
                    busy={restore.isPending && restore.variables === task.id}
                    onRestore={() => handleRestore(task)}
                  />
                ))}
              </ul>
              {data?.truncated ? (
                // Never let a cap read as "that task is gone" (ADR-0689).
                <p className="mt-3 text-xs text-neutral-text-secondary">
                  Showing the {rows.length} most recent deletions — older ones are not listed.
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** "3 days ago" / "today" from an ISO timestamp — mirrors the project Trash wording. */
function relativeDaysAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function DeletedMeta({ task }: { task: TrashedTask }) {
  const urgent = task.days_remaining !== null && task.days_remaining <= 7;
  return (
    <p className="text-[12px] text-neutral-text-secondary">
      {task.deleted_at ? `Deleted ${relativeDaysAgo(task.deleted_at)}` : 'Deleted'}
      {task.subtree_count > 0
        ? ` · restores ${task.subtree_count} subtask${task.subtree_count === 1 ? '' : 's'} with it`
        : ''}
      {task.deleted_at === null ? (
        ' · retained indefinitely'
      ) : task.days_remaining !== null ? (
        <>
          {' · '}
          <span className={urgent ? 'font-medium text-semantic-warning' : undefined}>
            auto-deletes in {task.days_remaining} {task.days_remaining === 1 ? 'day' : 'days'}
          </span>
        </>
      ) : null}
    </p>
  );
}

function TrashRow({
  task,
  busy,
  onRestore,
}: {
  task: TrashedTask;
  busy: boolean;
  onRestore: () => void;
}) {
  return (
    <li className="rounded-card border border-neutral-border bg-neutral-surface-raised p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {task.wbs_path ? (
              <code className="shrink-0 rounded-chip border border-neutral-border bg-neutral-surface-sunken px-1.5 py-0.5 tppm-mono text-xs text-neutral-text-secondary">
                {task.wbs_path}
              </code>
            ) : null}
            <h3 className="truncate text-[13px] font-semibold text-neutral-text-primary">
              {task.name}
            </h3>
          </div>
          <DeletedMeta task={task} />
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={onRestore}
          disabled={busy || !task.can_restore}
          className="shrink-0 max-sm:w-full"
          title={
            task.can_restore
              ? undefined
              : 'Only a project admin or the task’s assignee can restore this task.'
          }
        >
          {busy ? 'Restoring…' : 'Restore'}
        </Button>
      </div>
    </li>
  );
}
