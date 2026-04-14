import { useEffect, useRef, useState } from 'react';
import { useTaskAssignments } from '@/hooks/useTaskAssignments';
import {
  useAddAssignment,
  useUpdateAssignment,
  useRemoveAssignment,
} from '@/hooks/useAssignmentMutations';
import { AssignmentSkeleton } from './AssignmentSkeleton';
import { AssignmentRow } from './AssignmentRow';
import { ResourceSearchCombobox } from './ResourceSearchCombobox';

export interface ResourceAssignmentSectionProps {
  taskId: string;
  projectId: string;
}

export function ResourceAssignmentSection({ taskId, projectId }: ResourceAssignmentSectionProps) {
  const [showSearch, setShowSearch] = useState(false);
  const addResourceButtonRef = useRef<HTMLButtonElement>(null);

  // Reset search state when task changes
  useEffect(() => {
    setShowSearch(false);
  }, [taskId]);

  const { data: assignments, isLoading } = useTaskAssignments(taskId);
  const addAssignment = useAddAssignment(projectId);
  const updateAssignment = useUpdateAssignment(taskId, projectId);
  const removeAssignment = useRemoveAssignment(taskId, projectId);

  function handleSelectResource(resourceId: string, _resourceName: string) {
    addAssignment.mutate(
      { taskId, resourceId, units: 1.0 },
      {
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
    <section aria-label="Resource Assignments">
      <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
        Resources
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
              onRemove={() => removeAssignment.mutate(assignment.id)}
              isUpdating={
                updateAssignment.isPending &&
                (updateAssignment.variables as { id: string } | undefined)?.id === assignment.id
              }
              isRemoving={
                removeAssignment.isPending &&
                removeAssignment.variables === assignment.id
              }
            />
          ))}
        </>
      )}

      {/* Add resource controls */}
      <div className="mt-2">
        {showSearch ? (
          <ResourceSearchCombobox
            onSelect={handleSelectResource}
            onDismiss={handleDismiss}
          />
        ) : (
          <button
            ref={addResourceButtonRef}
            type="button"
            onClick={() => setShowSearch(true)}
            disabled={addAssignment.isPending}
            className="h-7 px-3 rounded text-xs border border-neutral-border
              text-neutral-text-secondary hover:text-neutral-text-primary hover:border-brand-primary
              disabled:opacity-40 disabled:cursor-not-allowed
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            + Add resource
          </button>
        )}
      </div>
    </section>
  );
}
