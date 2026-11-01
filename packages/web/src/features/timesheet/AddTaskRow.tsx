/**
 * "Add a task" row for the weekly timesheet grid (#1435).
 *
 * Lets a contributor start logging against an assigned task that is not a row this week.
 * Candidates are the caller's assigned tasks (`GET /me/work/`, read through the same
 * timesheet-owned query the page uses) minus the tasks already shown as rows — in
 * practice the COMPLETE assignments, which get no zero row (#4766) but can still need a
 * final hour logged. When every candidate is already a row the picker renders nothing
 * rather than an empty dropdown. A broader cross-project task search is #1416.
 */
import { useMemo } from 'react';
import { EntitySelectCombobox, type EntityOption } from '@/components/EntitySelectCombobox';
import { useTimesheetAssignments } from '@/hooks/useTimesheetAssignments';
import type { CellTaskMeta } from '@/hooks/useWeekTimesheet';
import { assignedTasks, myWorkTaskMeta } from './assignedTasks';

interface AddTaskRowProps {
  /** Task ids already shown as grid rows — excluded from the picker. */
  existingTaskIds: Set<string>;
  onAdd: (meta: CellTaskMeta) => void;
}

function initials(shortId: string): string {
  return shortId.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '#';
}

export function AddTaskRow({ existingTaskIds, onAdd }: AddTaskRowProps) {
  const { data, isLoading } = useTimesheetAssignments();

  const { options, metaById } = useMemo(() => {
    const options: EntityOption[] = [];
    const metaById = new Map<string, CellTaskMeta>();
    for (const task of assignedTasks(data?.tasks)) {
      if (existingTaskIds.has(task.id)) continue;
      const meta = myWorkTaskMeta(task);
      options.push({
        id: meta.taskId,
        primaryText: meta.taskName,
        secondaryText: `${meta.taskShortId} · ${meta.projectName}`,
        initials: initials(meta.taskShortId),
      });
      metaById.set(meta.taskId, meta);
    }
    return { options, metaById };
  }, [data, existingTaskIds]);

  // Every candidate is already a row — an "Add" control that opens onto nothing is a dead
  // affordance, so render nothing instead.
  if (!isLoading && options.length === 0) return null;

  return (
    <div className="flex items-center gap-2 border-t border-neutral-border px-3 py-2 text-sm">
      <span aria-hidden="true" className="text-neutral-text-secondary">
        +
      </span>
      <EntitySelectCombobox
        value={null}
        options={options}
        onChange={(id) => {
          if (id === null) return;
          const meta = metaById.get(id);
          if (meta) onAdd(meta);
        }}
        label="project or task"
        nullable={false}
        isLoading={isLoading}
        triggerLabel={{ set: 'Add project or task', unset: 'Add project or task' }}
      />
    </div>
  );
}
