/**
 * Bottom-center toast stack for the pull flow (05-states).
 *
 * - success: pull confirmation "Pulled to X." — auto-dismisses; once the pull
 *            resolves it offers a "Go to task" deep-link to the created task so
 *            the user can verify where the item went (#1994). No undo — there is
 *            no un-pull endpoint (a pulled task is corrected by deleting it,
 *            which resets the item to Proposed server-side).
 * - error:   critical-bordered, does NOT auto-dismiss; offers Details + Retry.
 *
 * The error toast is `role="alert"` so it's announced immediately; the others
 * are `role="status"`. Timing + state live on the controller; this is render.
 */

import { useState } from 'react';
import { Link } from 'react-router';
import { CloseIcon, WarningIcon } from '@/components/Icons';
import type { BacklogController } from '../hooks/useBacklogController';
import { FOCUS_RING } from './styles';

interface BacklogToastsProps {
  controller: BacklogController;
}

export function BacklogToasts({ controller }: BacklogToastsProps) {
  const { toast } = controller;
  const [showDetails, setShowDetails] = useState(false);

  if (!toast) return null;

  if (toast.kind === 'error') {
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4">
        <div
          role="alert"
          className="pointer-events-auto w-full max-w-[520px] rounded-card border border-l-[3px] border-semantic-critical bg-neutral-surface p-3"
        >
          <div className="flex items-start gap-2.5">
            <WarningIcon
              aria-hidden="true"
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-semantic-critical"
            />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-neutral-text-primary">
                {toast.offline
                  ? "Couldn't reach the server"
                  : `Couldn't pull to ${toast.project.name}`}
              </div>
              <p className="mt-0.5 text-xs text-neutral-text-secondary">
                {toast.offline
                  ? "You're offline. The item has been reverted to Proposed — try again when you reconnect."
                  : 'The project backlog rejected the task. Item has been reverted to Proposed.'}
              </p>
              {showDetails && (
                <p className="mt-1.5 rounded-card bg-neutral-surface-sunken p-2 text-xs text-neutral-text-secondary">
                  {toast.message}
                </p>
              )}
              <div className="mt-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setShowDetails((v) => !v)}
                  className={`text-xs font-medium text-neutral-text-secondary hover:text-neutral-text-primary ${FOCUS_RING}`}
                >
                  {showDetails ? 'Hide details' : 'Details'}
                </button>
                <button
                  type="button"
                  onClick={controller.retryPull}
                  className={`text-xs font-medium text-brand-primary hover:text-brand-primary-dark ${FOCUS_RING}`}
                >
                  Retry
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={controller.dismissToast}
              aria-label="Dismiss"
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-surface-sunken ${FOCUS_RING}`}
            >
              <CloseIcon aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // A pull success can deep-link to the task it created once the id is known.
  const goToTask =
    toast.projectId && toast.taskId
      ? `/projects/${toast.projectId}/tasks/${toast.taskId}`
      : null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto flex items-center gap-3 rounded-card bg-neutral-text-primary px-4 py-2.5 text-sm text-neutral-text-inverse border border-neutral-border"
      >
        <span>{toast.message}</span>
        {goToTask && (
          <Link
            to={goToTask}
            onClick={controller.dismissToast}
            className={`shrink-0 font-semibold text-neutral-text-inverse underline underline-offset-2 hover:opacity-80 ${FOCUS_RING}`}
          >
            Go to task
          </Link>
        )}
      </div>
    </div>
  );
}
