/**
 * Bottom-center toast stack for the pull flow (05-states).
 *
 * - undo:    "Pulled to X · Undo" — auto-dismisses after the 8s window.
 * - success: transient confirmation (undo done / retry ok) — 4s.
 * - error:   critical-bordered, does NOT auto-dismiss; offers Details + Retry.
 *
 * The error toast is `role="alert"` so it's announced immediately; the others
 * are `role="status"`. Timing + state live on the controller; this is render.
 */

import { useState } from 'react';
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
              <p className="mt-0.5 text-[11px] text-neutral-text-secondary">
                {toast.offline
                  ? "You're offline. The item has been reverted to Proposed — try again when you reconnect."
                  : 'The project backlog rejected the task. Item has been reverted to Proposed.'}
              </p>
              {showDetails && (
                <p className="mt-1.5 rounded-card bg-neutral-surface-sunken p-2 text-[11px] text-neutral-text-secondary">
                  {toast.message}
                </p>
              )}
              <div className="mt-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setShowDetails((v) => !v)}
                  className={`text-[11px] font-medium text-neutral-text-secondary hover:text-neutral-text-primary ${FOCUS_RING}`}
                >
                  {showDetails ? 'Hide details' : 'Details'}
                </button>
                <button
                  type="button"
                  onClick={controller.retryPull}
                  className={`text-[11px] font-medium text-brand-primary hover:text-brand-primary-dark ${FOCUS_RING}`}
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

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto flex items-center gap-3 rounded-card bg-neutral-text-primary px-4 py-2.5 text-sm text-neutral-text-inverse border border-neutral-border"
      >
        <span>{toast.message}</span>
      </div>
    </div>
  );
}
