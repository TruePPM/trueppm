import { WarningIcon } from '@/components/Icons';
import { useEffect, useRef, useState } from 'react';
import { useTaskAssignments } from '@/hooks/useTaskAssignments';
import {
  useAddAssignment,
  useUpdateAssignment,
  useRemoveAssignment,
  type AssignmentWarning,
} from '@/hooks/useAssignmentMutations';
import { AssignmentSkeleton } from './AssignmentSkeleton';
import { AssignmentRow } from './AssignmentRow';
import { ResourceSearchCombobox } from './ResourceSearchCombobox';

export interface ResourceAssignmentSectionProps {
  taskId: string;
  projectId: string;
  /** ADR-0133/1142: when false, assignments render read-only (no units input,
   *  no remove, no "+ Add resource") so a non-editor never hits a 403. */
  canEdit?: boolean;
}

export function ResourceAssignmentSection({
  taskId,
  projectId,
  canEdit = true,
}: ResourceAssignmentSectionProps) {
  const [showSearch, setShowSearch] = useState(false);
  const [overallocationWarning, setOverallocationWarning] = useState<AssignmentWarning | null>(null);
  const [skillMismatchWarning, setSkillMismatchWarning] = useState<AssignmentWarning | null>(null);
  const addResourceButtonRef = useRef<HTMLButtonElement>(null);

  // Reset search state and warnings when task changes
  useEffect(() => {
    setShowSearch(false);
    setOverallocationWarning(null);
    setSkillMismatchWarning(null);
  }, [taskId]);

  const { data: assignments, isLoading } = useTaskAssignments(taskId);
  const addAssignment = useAddAssignment(projectId);
  const updateAssignment = useUpdateAssignment(taskId, projectId);
  const removeAssignment = useRemoveAssignment(taskId, projectId);

  function handleSelectResource(resourceId: string, _resourceName: string) {
    addAssignment.mutate(
      { taskId, resourceId, units: 1.0 },
      {
        onSuccess: ({ warnings }) => {
          // Surface warnings inline — assignments are saved regardless.
          setOverallocationWarning(warnings.find((w) => w.code === 'resource_overallocated') ?? null);
          setSkillMismatchWarning(warnings.find((w) => w.code === 'skill_mismatch') ?? null);
        },
        onSettled: () => {
          setShowSearch(false);
          // Restore focus to the "Add resource" button
          setTimeout(() => addResourceButtonRef.current?.focus(), 50);
        },
      },
    );
  }

  function handleDismiss() {
    setShowSearch(false);
    setTimeout(() => addResourceButtonRef.current?.focus(), 50);
  }

  return (
    <section aria-label="Assignees">
      <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
        Assignees
      </h3>

      {isLoading ? (
        <AssignmentSkeleton />
      ) : (
        <>
          {assignments && assignments.length === 0 && (
            <p className="text-xs text-neutral-text-disabled mb-2">None</p>
          )}

          {assignments?.map((assignment) => (
            <AssignmentRow
              key={assignment.id}
              assignment={assignment}
              onUnitsChange={(decimal) =>
                updateAssignment.mutate({ id: assignment.id, units: decimal })
              }
              onRemove={() => {
                removeAssignment.mutate(assignment.id);
                // Clear warnings for this resource when the assignment is removed.
                if (overallocationWarning?.resource_id === assignment.resourceId) {
                  setOverallocationWarning(null);
                }
                if (skillMismatchWarning?.resource_id === assignment.resourceId) {
                  setSkillMismatchWarning(null);
                }
              }}
              isUpdating={
                updateAssignment.isPending &&
                (updateAssignment.variables as { id: string } | undefined)?.id === assignment.id
              }
              isRemoving={
                removeAssignment.isPending &&
                removeAssignment.variables === assignment.id
              }
              readOnly={!canEdit}
            />
          ))}

          {/* Overallocation warning — shown after a successful add when the resource
              is over capacity. Assignment is saved; this is informational only. */}
          {overallocationWarning && (
            <AssignmentWarningBanner
              warning={overallocationWarning}
              onDismiss={() => setOverallocationWarning(null)}
              dismissLabel="Dismiss overallocation warning"
            />
          )}

          {/* Skill mismatch warning — shown when the assigned resource lacks a required skill. */}
          {skillMismatchWarning && (
            <AssignmentWarningBanner
              warning={skillMismatchWarning}
              onDismiss={() => setSkillMismatchWarning(null)}
              dismissLabel="Dismiss skill mismatch warning"
            />
          )}
        </>
      )}

      {/* Add resource controls — hidden for non-editors (ADR-0133/1142). */}
      {canEdit && (
      <div className="mt-2">
        {showSearch ? (
          <ResourceSearchCombobox
            onSelect={handleSelectResource}
            onDismiss={handleDismiss}
            taskId={taskId}
          />
        ) : (
          <button
            ref={addResourceButtonRef}
            type="button"
            onClick={() => setShowSearch(true)}
            disabled={addAssignment.isPending}
            className="h-7 px-3 rounded-control text-xs border border-neutral-border
              text-neutral-text-secondary hover:text-neutral-text-primary hover:border-brand-primary
              disabled:opacity-40 disabled:cursor-not-allowed
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            + Add resource
          </button>
        )}
      </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared warning banner (overallocation + skill mismatch)
// ---------------------------------------------------------------------------

interface AssignmentWarningBannerProps {
  warning: AssignmentWarning;
  onDismiss: () => void;
  dismissLabel: string;
}

function AssignmentWarningBanner({ warning, onDismiss, dismissLabel }: AssignmentWarningBannerProps) {
  return (
    <div
      role="alert"
      className="mt-2 flex items-start gap-2 rounded-card border border-semantic-at-risk/40
        bg-transparent px-3 py-2 text-xs text-semantic-at-risk"
    >
      <WarningIcon className="mt-0.5 shrink-0 inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />
      <p className="flex-1">{warning.detail}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={dismissLabel}
        className="shrink-0 text-semantic-at-risk/60 hover:text-semantic-at-risk
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-at-risk
          focus-visible:ring-offset-1 rounded-control"
      >
        ✕
      </button>
    </div>
  );
}
