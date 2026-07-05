/**
 * "Add a task" row for the weekly timesheet grid (#1435).
 *
 * Lets a contributor start logging against a task not yet in the grid. The candidate
 * source is the caller's cross-project assigned tasks (`GET /me/work/` via `useMyWork`) —
 * the tasks a contributor most plausibly logs against — filtered to exclude tasks already
 * shown as rows. A broader cross-project task search is a follow-up owned by the shared
 * quick-log picker (#1416); this keeps the add-row functional without that dependency.
 */
import { useMemo } from 'react';
import { EntitySelectCombobox, type EntityOption } from '@/components/EntitySelectCombobox';
import { useMyWork } from '@/hooks/useMyWork';
import type { CellTaskMeta } from '@/hooks/useWeekTimesheet';

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
    const tasks = (data?.pages ?? []).flatMap((p) => p.results);
    const seen = new Set<string>();
    const options: EntityOption[] = [];
    const metaById = new Map<string, CellTaskMeta>();
    for (const t of tasks) {
      if (existingTaskIds.has(t.id) || seen.has(t.id)) continue;
      seen.add(t.id);
      options.push({
        id: t.id,
        primaryText: t.name,
        secondaryText: `${t.short_id} · ${t.project_name}`,
        initials: initials(t.short_id),
      });
      metaById.set(t.id, {
        taskId: t.id,
        taskShortId: t.short_id,
        taskName: t.name,
        projectId: t.project_id,
        // project_code is not on the /me/work payload; the optimistic row shows the name,
        // and the authoritative code arrives on the next weekly refetch.
        projectCode: '',
        projectName: t.project_name,
      });
    }
    return { options, metaById };
  }, [data, existingTaskIds]);

  return (
    <div className="flex items-center gap-2 px-3 py-2 text-sm">
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
