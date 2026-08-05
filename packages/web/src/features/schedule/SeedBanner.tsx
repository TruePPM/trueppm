import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { toast } from '@/components/Toast/toast';
import { useProject } from '@/hooks/useProject';
import {
  useDeleteUntouchedSeededTasks,
  useTemplateApplication,
  useUndoTemplateApplication,
} from '@/hooks/useProjectTemplates';
import { ROLE_ADMIN } from '@/lib/roles';
import type { Task } from '@/types';

interface SeedBannerProps {
  projectId: string;
  applicationId: string;
  /** The already-loaded schedule — `isUntouchedSeed` is read live, never re-fetched. */
  tasks: readonly Task[];
  /** The caller's role on this project; `null` while loading. */
  currentRole: number | null;
  onDismiss: () => void;
}

/**
 * The seed banner (#2731, ADR-0799 §1) — the plan and the fastest way to disagree
 * with it, mounted the moment a waterfall/hybrid template apply lands on Schedule.
 *
 * Disposability is the design (issue #2731): every affordance here is an offer,
 * never a commitment. "Delete untouched rows" and "Undo apply" only appear for
 * Admin+ (ADR-0773 §4) — a control that would 403 must never read as actionable —
 * and both are recoverable (undo's own asymmetry is ADR-0786 §4; deleted rows are a
 * soft-delete, not gone). Returns `null` while the application is still
 * pending/running (nothing to summarize yet — the WebSocket delivers the rows, this
 * banner is not a progress bar) or once it has been undone (the offer no longer
 * applies to anything).
 */
export function SeedBanner({
  projectId,
  applicationId,
  tasks,
  currentRole,
  onDismiss,
}: SeedBannerProps) {
  const { data: application } = useTemplateApplication(applicationId);
  const { data: projectDetail } = useProject(projectId);
  const undoMutation = useUndoTemplateApplication();
  const deleteMutation = useDeleteUntouchedSeededTasks();
  const queryClient = useQueryClient();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const canManage = currentRole !== null && currentRole >= ROLE_ADMIN;

  // Live, not the frozen result_summary count — rows can have been touched or
  // deleted since apply, and the delete offer must reflect what would actually
  // be removed right now (the server re-derives the same set at delete time).
  const untouchedCount = useMemo(() => tasks.filter((t) => t.isUntouchedSeed).length, [tasks]);

  const handleUndo = useCallback(() => {
    undoMutation.mutate(applicationId, {
      onSuccess: (data) => {
        toast.success(
          data.undo.kept > 0
            ? `Undone — removed ${data.undo.deleted}, kept ${data.undo.kept} you'd already touched.`
            : `Undone — removed ${data.undo.deleted} row${data.undo.deleted === 1 ? '' : 's'}.`,
        );
        void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
        void queryClient.invalidateQueries({ queryKey: ['dependencies', projectId] });
        onDismiss();
      },
      onError: () => toast.error("Couldn't undo the template apply. Try again."),
    });
  }, [applicationId, undoMutation, queryClient, projectId, onDismiss]);

  // "Undo apply ⌘Z" (issue #2731) — Cmd+Z on macOS, Ctrl+Z elsewhere. Never
  // steals the shortcut from a text field: a person mid-edit pressing Cmd+Z
  // means "undo my typing", not "undo the template".
  useEffect(() => {
    if (!canManage || application?.status !== 'success') return;
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      handleUndo();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canManage, application?.status, handleUndo]);

  const handleDeleteUntouched = useCallback(() => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    deleteMutation.mutate(projectId, {
      onSuccess: (data) => {
        toast.success(
          data.deleted === 1 ? 'Deleted 1 untouched row.' : `Deleted ${data.deleted} untouched rows.`,
        );
        void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
        void queryClient.invalidateQueries({ queryKey: ['dependencies', projectId] });
        setConfirmingDelete(false);
      },
      onError: () => {
        toast.error("Couldn't delete the untouched rows. Try again.");
        setConfirmingDelete(false);
      },
    });
  }, [confirmingDelete, deleteMutation, projectId, queryClient]);

  if (!application || application.status !== 'success') return null;

  const summary = application.result_summary;
  const calendarName = projectDetail?.effective_calendar?.name ?? 'the default calendar';
  const countParts = [
    summary.tasks_created !== undefined
      ? `${summary.tasks_created} row${summary.tasks_created === 1 ? '' : 's'}`
      : null,
    summary.milestones_created !== undefined
      ? `${summary.milestones_created} milestone${summary.milestones_created === 1 ? '' : 's'}`
      : null,
    summary.dependencies_created !== undefined
      ? `${summary.dependencies_created} dependenc${summary.dependencies_created === 1 ? 'y' : 'ies'}`
      : null,
    `scheduled on ${calendarName}`,
  ].filter((x): x is string => x !== null);

  return (
    <section
      data-testid="seed-banner"
      aria-label="Seeded from template"
      className="flex flex-shrink-0 flex-col gap-1.5 border-b border-neutral-border bg-neutral-surface-raised px-4 py-2"
    >
      {/* Always present once mounted, so the region is in the accessibility tree
          before its text can change (mirrors ScheduleReconcileStrip's rationale). */}
      <span role="status" aria-live="polite" data-testid="seed-banner-live" className="sr-only">
        {`Skeleton written from "${application.template_name}". ${countParts.join(', ')}.`}
      </span>

      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <p className="text-xs text-neutral-text-primary">
            <span className="font-medium">
              Skeleton written from &ldquo;{application.template_name}&rdquo;.
            </span>{' '}
            <span className="text-neutral-text-secondary">
              Rename, delete, rearrange — none of it is load-bearing.
            </span>
          </p>
          <p
            data-testid="seed-banner-counts"
            className="tppm-mono mt-0.5 text-xs text-neutral-text-secondary"
          >
            {countParts.join(' · ')}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss seed banner"
          data-testid="seed-banner-dismiss"
          className="ml-auto shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-control
            text-neutral-text-secondary hover:bg-neutral-surface-sunken
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          ×
        </button>
      </div>

      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          {untouchedCount > 0 && (
            <>
              <Button
                variant="secondary"
                size="sm"
                data-testid="seed-banner-delete-untouched"
                onClick={handleDeleteUntouched}
                disabled={deleteMutation.isPending}
              >
                {confirmingDelete
                  ? `Confirm delete (${untouchedCount})?`
                  : `Delete untouched rows (${untouchedCount})`}
              </Button>
              {confirmingDelete && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleteMutation.isPending}
                >
                  Cancel
                </Button>
              )}
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            data-testid="seed-banner-undo"
            onClick={handleUndo}
            disabled={undoMutation.isPending}
          >
            Undo apply <span className="text-neutral-text-secondary">⌘Z</span>
          </Button>
        </div>
      )}
    </section>
  );
}
