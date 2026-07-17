/**
 * Update-project-status dialog (issue 1606).
 *
 * A shortcut from the Project Overview header to record the PM's MANUAL health
 * override (`Project.health`) without visiting Settings > General. This is the
 * PM's reported judgment call — it surfaces in project lists and rollups and is
 * deliberately distinct from the computed schedule-health SPI proxy shown on the
 * overview KPI badge.
 *
 * Frontend-only: writes through the existing `useUpdateProject` hook
 * (PATCH /api/v1/projects/:id/). The server gates the `health` field to Admin+
 * in ProjectSerializer.validate() and broadcasts `project_updated` on commit, so
 * this dialog adds no new API surface. The MCP write counterpart is tracked in
 * issue 505.
 *
 * `role="dialog" aria-modal="true"` with focus on the Cancel (safe) control on
 * open; Escape and scrim-click cancel. Below Admin the pills render read-only and
 * the Save action is withheld — the render-gate mirrors ProjectGeneralPage and
 * only spares a non-Admin the arm-save → 400 round-trip; the server stays the
 * real gate.
 */

import { useEffect, useRef, useState } from 'react';
import type { AxiosError } from 'axios';
import type { ProjectHealth } from '@/api/types';
import { useUpdateProject } from '@/hooks/useProjectMutations';
import { HEALTH_OPTIONS, HEALTH_ACTIVE, HEALTH_LABEL } from '@/features/project/projectHealth';
import { ReadOnlyIndicator } from '@/features/settings/components/ReadOnlyIndicator';

interface UpdateStatusDialogProps {
  projectId: string;
  /** The project's current manual health override, pre-selected on open. */
  currentHealth: ProjectHealth;
  /** True when the current user may change the reported status (Admin+). */
  canEdit: boolean;
  onClose: () => void;
}

function errorMessage(err: unknown): string {
  const axiosErr = err as AxiosError<{ detail?: string; health?: string[] }>;
  const data = axiosErr?.response?.data;
  if (data?.health?.length) return data.health[0];
  if (data?.detail) return data.detail;
  return 'Could not update status. Try again.';
}

export function UpdateStatusDialog({
  projectId,
  currentHealth,
  canEdit,
  onClose,
}: UpdateStatusDialogProps) {
  const [selected, setSelected] = useState<ProjectHealth>(currentHealth);
  const [error, setError] = useState<string | null>(null);
  const updateProject = useUpdateProject(projectId);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Escape cancels; stopPropagation so it does not bubble to a parent handler.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const busy = updateProject.isPending;
  const canSave = canEdit && selected !== currentHealth && !busy;

  async function handleSave() {
    setError(null);
    try {
      await updateProject.mutateAsync({ health: selected });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-status-title"
      aria-describedby="update-status-body"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mx-4 w-full max-w-md rounded-card border border-neutral-border bg-neutral-surface p-5 motion-safe:animate-modal-scale-in">
        <h2 id="update-status-title" className="mb-2 text-sm font-semibold text-neutral-text-primary">
          Update project status
        </h2>
        <p id="update-status-body" className="mb-4 text-xs text-neutral-text-secondary">
          Set the health you&apos;re reporting for this project. It appears in project lists and
          rollups, and is separate from the schedule health computed from your plan.
        </p>

        {canEdit ? (
          <div
            className="mb-3 flex flex-wrap gap-2"
            role="group"
            aria-label="Reported project health"
          >
            {HEALTH_OPTIONS.map((opt) => {
              const isSelected = selected === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={busy}
                  onClick={() => setSelected(opt.id)}
                  aria-pressed={isSelected}
                  className={[
                    'px-3 py-1 rounded-control border text-[12px] font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                    'disabled:cursor-not-allowed',
                    isSelected
                      ? HEALTH_ACTIVE[opt.id]
                      : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken disabled:hover:bg-transparent',
                  ].join(' ')}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="mb-3">
            <ReadOnlyIndicator
              label="Reported status"
              value={HEALTH_LABEL[currentHealth]}
              provenance="set by the Project Manager"
            />
          </div>
        )}

        <p className="mb-4 text-xs text-neutral-text-secondary">
          {canEdit
            ? 'Auto defers to the schedule signal — pick it to clear a manual report.'
            : 'Only a Project Manager can change the reported status.'}
        </p>

        {error ? (
          <p className="mb-3 text-xs text-semantic-critical" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            className="h-8 rounded border border-neutral-border bg-transparent px-3 text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            {canEdit ? 'Cancel' : 'Close'}
          </button>
          {canEdit ? (
            <button
              type="button"
              disabled={!canSave}
              onClick={() => void handleSave()}
              className={[
                'h-8 rounded border-none px-3 text-[13px] font-medium text-white transition-opacity',
                'bg-brand-primary hover:bg-brand-primary-dark',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary',
                'disabled:cursor-not-allowed disabled:opacity-50',
              ].join(' ')}
            >
              {busy ? 'Saving…' : 'Save status'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
