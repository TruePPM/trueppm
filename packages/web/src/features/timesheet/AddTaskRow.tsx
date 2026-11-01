/**
 * "Add a task" row for the weekly timesheet grid (#1435).
 *
 * Lets a contributor start logging against a task not yet in the grid. The candidate
 * source is the caller's cross-project assigned tasks (`GET /me/work/` via `useMyWork`),
 * filtered to exclude tasks already shown as rows. Since #4766 the page already renders
 * every loaded assignment as a row, so the picker usually has nothing to offer and then
 * renders nothing rather than an empty dropdown; it stays as the entry point a broader
 * cross-project task search (#1416) will feed.
 */
import { useMemo } from 'react';
import { EntitySelectCombobox, type EntityOption } from '@/components/EntitySelectCombobox';
import { useMyWork } from '@/hooks/useMyWork';
import type { CellTaskMeta } from '@/hooks/useWeekTimesheet';
import { assignedTaskMetas } from './assignedTasks';

interface AddTaskRowProps {
  /** Task ids already shown as grid rows — excluded from the picker. */
  existingTaskIds: Set<string>;
  onAdd: (meta: CellTaskMeta) => void;
}

function initials(shortId: string): string {
  return shortId.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '#';
}

export function AddTaskRow({ existingTaskIds, onAdd }: AddTaskRowProps) {
  const { data, isLoading } = useMyWork();

  const { options, metaById } = useMemo(() => {
    const options: EntityOption[] = [];
    const metaById = new Map<string, CellTaskMeta>();
    for (const meta of assignedTaskMetas(data?.pages)) {
      if (existingTaskIds.has(meta.taskId)) continue;
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
