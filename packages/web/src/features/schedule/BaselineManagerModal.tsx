import { useMemo, useState } from 'react';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { ClockIcon, CloseIcon, WarningIcon } from '@/components/Icons';
import { QueryErrorState } from '@/components/QueryErrorState';
import { toast } from '@/components/Toast';
import { CaptureBaselineConfirmDialog } from './CaptureBaselineConfirmDialog';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useProjectMembers } from '@/hooks/useProjectMembers';
import {
  useActivateBaseline,
  useBaselines,
  useCreateBaseline,
  useDeleteBaseline,
  type ApiBaseline,
} from '@/hooks/useBaselines';
import { ROLE_ADMIN, ROLE_OWNER } from '@/lib/roles';

interface BaselineManagerModalProps {
  projectId: string;
  /** Caller's project role ordinal (from useCurrentUserRole); null while loading. */
  currentRole: number | null;
  onClose: () => void;
}

function fmtCapturedAt(iso: string): string {
  // created_at is a full timestamptz — local formatting is correct for a
  // "captured at this moment" stamp (unlike UTC-only plan dates, web-rule 189).
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Project-level baseline manager (ADR-0376, #1864). Lists baselines and wires
 * the existing capture / activate / delete hooks to UI. Launched from the
 * Schedule toolbar Actions (···) menu.
 *
 * Role gates are render-gates only — the server is authoritative (create →
 * IsProjectAdmin, destroy → IsProjectOwner) and 403s regardless. Activate and
 * delete are immediate row actions (web-rule 217 instant-toggle carve-out);
 * delete is destructive so it routes through a self-trapping confirm (web-rule
 * 206). The modal yields its own focus trap while that confirm is open (#1776).
 */
export function BaselineManagerModal({
  projectId,
  currentRole,
  onClose,
}: BaselineManagerModalProps) {
  const canCapture = currentRole != null && currentRole >= ROLE_ADMIN;
  const canActivate = canCapture;
  const canDelete = currentRole != null && currentRole >= ROLE_OWNER;

  const { data: baselines = [], isLoading, isError, refetch } = useBaselines(projectId);
  const { members } = useProjectMembers(projectId);
  const nameById = useMemo(
    () => new Map(members.map((m) => [m.id, m.username])),
    [members],
  );

  const createBaseline = useCreateBaseline(projectId);
  const activateBaseline = useActivateBaseline(projectId);
  const deleteBaseline = useDeleteBaseline(projectId);

  const [deleteTarget, setDeleteTarget] = useState<ApiBaseline | null>(null);
  const [showCaptureConfirm, setShowCaptureConfirm] = useState(false);

  // Yield the trap while a nested confirm (capture or delete) is open (web-rule 245/206).
  const trapRef = useFocusTrap<HTMLDivElement>(
    deleteTarget === null && !showCaptureConfirm,
    onClose,
  );

  const activeBaselineName = baselines.find((b) => b.is_active)?.name;

  function handleCaptureConfirmed() {
    if (!navigator.onLine) {
      toast.info("You're offline — reconnect to capture a baseline.");
      return;
    }
    createBaseline.mutate(
      {},
      {
        onSuccess: (b) => {
          toast.success(`Captured ${b.name}`);
          setShowCaptureConfirm(false);
        },
        onError: () => toast.error("Couldn't capture baseline — try again."),
      },
    );
  }

  function handleActivate(b: ApiBaseline) {
    if (!navigator.onLine) {
      toast.info("You're offline — reconnect to change the active baseline.");
      return;
    }
    activateBaseline.mutate(b.id, {
      onSuccess: () => toast.success(`${b.name} is now the active baseline`),
      onError: () => toast.error("Couldn't activate baseline — try again."),
    });
  }

  function handleConfirmDelete() {
    const b = deleteTarget;
    if (!b) return;
    if (!navigator.onLine) {
      toast.info("You're offline — reconnect to delete a baseline.");
      return;
    }
    deleteBaseline.mutate(b.id, {
      onSuccess: () => {
        toast.success(`Deleted ${b.name}`);
        setDeleteTarget(null);
      },
      // On error keep the confirm open; deleteBaseline.isError drives the inline message.
    });
  }

  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="baseline-manager-title"
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
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-neutral-border px-5 py-4">
          <div className="min-w-0">
            <h2
              id="baseline-manager-title"
              className="text-base font-semibold text-neutral-text-primary"
            >
              Baselines
            </h2>
            <p className="mt-0.5 text-xs text-neutral-text-secondary">
              Snapshots of this project&apos;s planned schedule.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {canCapture && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowCaptureConfirm(true)}
                disabled={createBaseline.isPending}
              >
                Capture baseline
              </Button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close baselines"
              className="flex h-8 w-8 items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-surface-sunken hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              <CloseIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]">
          {isLoading ? (
            <LoadingRows />
          ) : isError ? (
            <QueryErrorState
              variant="inline"
              message="Couldn't load baselines."
              onRetry={() => void refetch()}
            />
          ) : baselines.length === 0 ? (
            <EmptyState
              icon={ClockIcon}
              title="No baselines yet"
              description="Capture a baseline to freeze the current plan and track how the schedule drifts from it."
              action={
                canCapture ? (
                  <Button
                    variant="primary"
                    onClick={() => setShowCaptureConfirm(true)}
                    disabled={createBaseline.isPending}
                  >
                    Capture baseline
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <ul className="flex flex-col">
                {baselines.map((b) => (
                  <BaselineRow
                    key={b.id}
                    baseline={b}
                    capturedBy={b.created_by ? nameById.get(b.created_by) : undefined}
                    canActivate={canActivate}
                    canDelete={canDelete}
                    activating={activateBaseline.isPending}
                    onActivate={handleActivate}
                    onDelete={setDeleteTarget}
                  />
                ))}
              </ul>
              {!canCapture && (
                <p className="mt-4 text-xs text-neutral-text-secondary">
                  Baselines are captured by a project admin.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {showCaptureConfirm && (
        <CaptureBaselineConfirmDialog
          activeBaselineName={activeBaselineName}
          isPending={createBaseline.isPending}
          onCancel={() => {
            if (!createBaseline.isPending) setShowCaptureConfirm(false);
          }}
          onConfirm={handleCaptureConfirmed}
        />
      )}

      {deleteTarget && (
        <BaselineDeleteConfirm
          baseline={deleteTarget}
          isPending={deleteBaseline.isPending}
          isError={deleteBaseline.isError}
          onCancel={() => {
            if (!deleteBaseline.isPending) {
              deleteBaseline.reset();
              setDeleteTarget(null);
            }
          }}
          onConfirm={handleConfirmDelete}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface BaselineRowProps {
  baseline: ApiBaseline;
  capturedBy: string | undefined;
  canActivate: boolean;
  canDelete: boolean;
  activating: boolean;
  onActivate: (b: ApiBaseline) => void;
  onDelete: (b: ApiBaseline) => void;
}

function BaselineRow({
  baseline,
  capturedBy,
  canActivate,
  canDelete,
  activating,
  onActivate,
  onDelete,
}: BaselineRowProps) {
  const active = baseline.is_active;
  return (
    <li className="flex items-start justify-between gap-3 border-b border-neutral-border py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {/* State dot is decorative; the "Active" word is the non-color signal (web-rule 6/120). */}
          <span
            aria-hidden="true"
            className={`h-2 w-2 shrink-0 rounded-full ${
              active ? 'bg-semantic-on-track' : 'border border-neutral-text-secondary'
            }`}
          />
          <span className="truncate text-sm font-medium text-neutral-text-primary">
            {baseline.name}
          </span>
          {active && (
            <span className="rounded-chip bg-semantic-on-track-bg px-2 py-0.5 text-xs font-medium text-semantic-on-track">
              Active
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-neutral-text-secondary">
          Captured <span className="tppm-mono">{fmtCapturedAt(baseline.created_at)}</span>
          {capturedBy ? ` · by ${capturedBy}` : ''} · {baseline.task_count} task
          {baseline.task_count === 1 ? '' : 's'}
        </p>
        {!baseline.has_cpm_dates && (
          <p className="mt-1 flex items-center gap-1 text-xs text-neutral-text-secondary">
            <WarningIcon className="inline-block h-3 w-3 shrink-0" aria-hidden="true" />
            Captured before the schedule was fully calculated
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canActivate && !active && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onActivate(baseline)}
            disabled={activating}
          >
            Set active
          </Button>
        )}
        {canDelete && (
          <Button variant="danger" size="sm" onClick={() => onDelete(baseline)}>
            Delete
          </Button>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Delete confirm — self-trapping (web-rule 206)
// ---------------------------------------------------------------------------

interface BaselineDeleteConfirmProps {
  baseline: ApiBaseline;
  isPending: boolean;
  isError: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function BaselineDeleteConfirm({
  baseline,
  isPending,
  isError,
  onCancel,
  onConfirm,
}: BaselineDeleteConfirmProps) {
  // Owns its own trap; Cancel is first in DOM so the trap seats focus on it,
  // never on the destructive button (web-rule 206).
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);
  return (
    <div
      ref={trapRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="baseline-delete-title"
      aria-describedby="baseline-delete-body"
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay p-4 focus:outline-none motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !isPending) onCancel();
      }}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-neutral-border bg-neutral-surface p-5 shadow-pop motion-safe:animate-modal-scale-in"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2
          id="baseline-delete-title"
          className="mb-2 text-sm font-semibold text-neutral-text-primary"
        >
          Delete this baseline?
        </h2>
        <p id="baseline-delete-body" className="mb-4 text-xs text-neutral-text-secondary">
          &ldquo;{baseline.name}&rdquo; and its {baseline.task_count}-task snapshot will be
          permanently removed. Task comparisons that use it will no longer have a baseline.
          This can&apos;t be undone.
        </p>
        {isError && (
          <p role="alert" className="mb-3 text-xs text-semantic-critical">
            Couldn&apos;t delete — try again.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={onConfirm} disabled={isPending}>
            {isPending ? 'Deleting…' : 'Delete baseline'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton (web-rule 248)
// ---------------------------------------------------------------------------

function LoadingRows() {
  return (
    <div role="status" aria-label="Loading baselines…" className="flex flex-col gap-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="motion-safe:animate-pulse">
          <div className="h-4 w-40 rounded bg-neutral-surface-sunken" aria-hidden="true" />
          <div className="mt-2 h-3 w-56 rounded bg-neutral-surface-sunken" aria-hidden="true" />
        </div>
      ))}
    </div>
  );
}
