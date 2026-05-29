/**
 * Right-pane detail panel for a selected ProjectResource.
 * Shows full skill list with proficiency, capacity editor, notes, and remove button.
 */
import { useState } from 'react';
import type { ProjectResource } from '@/types';
import { PROFICIENCY_LABEL } from '@/types';
import { CapacityInput } from './CapacityInput';
import { CascadeDeleteDialog } from './CascadeDeleteDialog';
import { useUpdateProjectResource, useRemoveProjectResource } from '@/hooks/useProjectResourcePool';

interface RosterDetailPanelProps {
  projectResource: ProjectResource;
  /** Hours/day from the project's default calendar — used as fallback. */
  defaultCalendarHoursPerDay?: number;
  onClose?: () => void;
}

type RemoveState =
  | { phase: 'idle' }
  | { phase: 'confirm-cascade'; assignmentCount: number }
  | { phase: 'removing' };

export function RosterDetailPanel({
  projectResource,
  defaultCalendarHoursPerDay = 8,
  onClose,
}: RosterDetailPanelProps) {
  const { resource } = projectResource;
  const [removeState, setRemoveState] = useState<RemoveState>({ phase: 'idle' });

  const updateMutation = useUpdateProjectResource(projectResource.projectId);
  const removeMutation = useRemoveProjectResource(projectResource.projectId);

  function handleCapacityChange(value: number) {
    updateMutation.mutate({ id: projectResource.id, unitsOverride: value });
  }

  function handleRemoveClick() {
    // Attempt a soft delete first; API returns 409 if assignments exist.
    removeMutation.mutate(
      { id: projectResource.id, force: false },
      {
        onSuccess: () => {
          onClose?.();
        },
        onError: (err) => {
          const status = (
            err as { response?: { status: number; data: { cascaded_assignment_count?: number } } }
          ).response?.status;
          if (status === 409) {
            const count =
              (err as { response?: { data: { cascaded_assignment_count?: number } } }).response
                ?.data?.cascaded_assignment_count ?? 1;
            setRemoveState({ phase: 'confirm-cascade', assignmentCount: count });
          }
        },
      },
    );
  }

  function handleForceRemove() {
    setRemoveState({ phase: 'removing' });
    removeMutation.mutate(
      { id: projectResource.id, force: true },
      {
        onSuccess: () => onClose?.(),
        onError: () => setRemoveState({ phase: 'idle' }),
      },
    );
  }

  const skills = resource.skills ?? [];
  // Calendar hours/day: resource's calendar is not loaded in detail here; use default.
  const calendarHoursPerDay = defaultCalendarHoursPerDay;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-start justify-between p-4 border-b border-neutral-border">
        <div>
          <h2 className="text-base font-semibold text-neutral-text-primary">{resource.name}</h2>
          {resource.jobRole && (
            <p className="text-sm text-neutral-text-secondary mt-0.5">{resource.jobRole}</p>
          )}
          {resource.email && (
            <p className="text-xs text-neutral-text-disabled mt-0.5">{resource.email}</p>
          )}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detail panel"
            className="p-1 rounded text-neutral-text-disabled hover:text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M12 4L4 12M4 4l8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>

      <div className="flex flex-col gap-5 p-4">
        {/* Capacity */}
        <section aria-labelledby="capacity-heading">
          <h3
            id="capacity-heading"
            className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-3"
          >
            Capacity
          </h3>
          <CapacityInput
            value={projectResource.unitsOverride ?? projectResource.effectiveMaxUnits}
            onChange={handleCapacityChange}
            calendarHoursPerDay={calendarHoursPerDay}
            isOverride={projectResource.unitsOverride !== null}
          />
        </section>

        {/* Role title */}
        {projectResource.roleTitle && (
          <section aria-labelledby="role-heading">
            <h3
              id="role-heading"
              className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-1"
            >
              Role on project
            </h3>
            <p className="text-sm text-neutral-text-primary">{projectResource.roleTitle}</p>
          </section>
        )}

        {/* Notes */}
        {projectResource.notes && (
          <section aria-labelledby="notes-heading">
            <h3
              id="notes-heading"
              className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-1"
            >
              Notes
            </h3>
            <p className="text-sm text-neutral-text-secondary">{projectResource.notes}</p>
          </section>
        )}

        {/* Skills */}
        <section aria-labelledby="skills-heading">
          <h3
            id="skills-heading"
            className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-3"
          >
            Skills
          </h3>
          {skills.length === 0 ? (
            <p className="text-sm text-neutral-text-disabled">No skills recorded</p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label="Skills">
              {skills.map((s) => (
                <li key={s.id} className="flex items-center justify-between">
                  <span className="text-sm text-neutral-text-primary">{s.skill.name}</span>
                  <span className="text-xs text-neutral-text-secondary">
                    {PROFICIENCY_LABEL[s.proficiency]}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {/* Enterprise extension slot */}
          <div data-slot="resource-detail-skills-extension" />
        </section>

        {/* Remove from project */}
        <section className="pt-2 border-t border-neutral-border mt-auto">
          <button
            type="button"
            onClick={handleRemoveClick}
            disabled={removeMutation.isPending}
            className="w-full h-10 rounded border border-semantic-critical/40 text-sm font-medium
              text-semantic-critical bg-semantic-critical-bg hover:bg-semantic-critical/10
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1
              disabled:opacity-50 transition-colors"
          >
            {removeMutation.isPending ? 'Removing…' : 'Remove from project'}
          </button>
          {/* Enterprise extension slot */}
          <div data-slot="resource-pool-row-actions" />
        </section>
      </div>

      {/* Cascade delete confirmation */}
      {(removeState.phase === 'confirm-cascade' || removeState.phase === 'removing') && (
        <CascadeDeleteDialog
          resourceName={resource.name}
          assignmentCount={
            removeState.phase === 'confirm-cascade' ? removeState.assignmentCount : 0
          }
          onConfirm={handleForceRemove}
          onCancel={() => setRemoveState({ phase: 'idle' })}
          isLoading={removeState.phase === 'removing'}
        />
      )}
    </div>
  );
}
