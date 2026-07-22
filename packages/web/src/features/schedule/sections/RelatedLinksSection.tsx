import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import type { TaskRelation } from '@/types';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useProject } from '@/hooks/useProject';
import {
  useDeleteTaskRelation,
  useTaskRelations,
} from '@/hooks/useTaskRelations';
import { canEditTask } from '@/lib/roles';
import { RELATION_HEADING_ORDER, relationLabel } from './relationLabel';
import { RelatedLinkPicker } from './RelatedLinkPicker';

/**
 * A relation resolved to a single displayable row from the viewer's vantage
 * point: the inverse-aware heading, the counterpart's identity, and where a
 * click should go (same-project selection vs cross-project navigation).
 */
interface DisplayRow {
  relationId: string;
  heading: string;
  counterpartId: string;
  hexId: string;
  name: string;
  /** Non-null ⇒ the counterpart is cross-project; carries its project name. */
  crossProjectName: string | null;
  /** Project to navigate to for a cross-project counterpart; null when local. */
  crossProjectId: string | null;
}

/**
 * Related links section (#2068) — relative, non-scheduling cross-references
 * between tasks (relates-to / blocks / duplicates). Rows are grouped under an
 * inverse-aware heading ("Blocks" for an outgoing block, "Blocked by" for an
 * incoming one). Clicking a same-project row selects that task in the schedule;
 * a cross-project row navigates to its task detail page. Write controls (× and
 * the "Link task" trigger) are gated on the drawer's `canEdit` verdict.
 *
 * Self-contained per ADR-0050: it fetches its own relations by `taskId` and
 * resolves same-project counterparts from the shared schedule cache; `programId`
 * is resolved here via `useProject` rather than widened onto DrawerSectionProps.
 */
export function RelatedLinksSection({ taskId, projectId, userRole, canEdit }: DrawerSectionProps) {
  const { outgoing, incoming, isLoading, error } = useTaskRelations(taskId);
  const { tasks } = useScheduleTasks();
  const { data: projectDetail } = useProject(projectId);
  const deleteRel = useDeleteTaskRelation(taskId);
  const navigate = useNavigate();
  const setSelectedTaskId = useScheduleStore((s) => s.setSelectedTaskId);

  const [pickerOpen, setPickerOpen] = useState(false);

  const programId = projectDetail?.program ?? null;
  const task = tasks?.find((t) => t.id === taskId) ?? null;
  const taskById = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks]);
  // Prefer the server-derived per-task verdict threaded down by the drawer; fall
  // back to the client role rule only when it is absent (ADR-0133).
  const editable = canEdit ?? canEditTask(userRole);

  // Resolve every relation to a display row from this task's vantage point.
  const rows = useMemo<DisplayRow[]>(() => {
    const toRow = (rel: TaskRelation, direction: 'outgoing' | 'incoming'): DisplayRow => {
      const heading = relationLabel(rel.relationType, direction);
      const card = direction === 'outgoing' ? rel.targetCard : rel.sourceCard;
      if (card) {
        return {
          relationId: rel.id,
          heading,
          counterpartId: card.id,
          hexId: card.hexId,
          name: card.title,
          crossProjectName: card.projectName,
          crossProjectId: card.projectId,
        };
      }
      const counterpartId = direction === 'outgoing' ? rel.target : rel.source;
      const local = taskById.get(counterpartId);
      return {
        relationId: rel.id,
        heading,
        counterpartId,
        hexId: local?.shortId ?? local?.wbs ?? '',
        name: local?.name ?? 'Unknown task',
        crossProjectName: null,
        crossProjectId: null,
      };
    };
    return [
      ...outgoing.map((r) => toRow(r, 'outgoing')),
      ...incoming.map((r) => toRow(r, 'incoming')),
    ];
  }, [outgoing, incoming, taskById]);

  // Counterpart ids already related (+ the task itself) — excluded from the picker.
  const excludedIds = useMemo(() => {
    const ids = new Set<string>([taskId]);
    for (const row of rows) ids.add(row.counterpartId);
    return ids;
  }, [rows, taskId]);

  // Group rows under their heading, in canonical order.
  const groups = useMemo(() => {
    const byHeading = new Map<string, DisplayRow[]>();
    for (const row of rows) {
      const list = byHeading.get(row.heading) ?? [];
      list.push(row);
      byHeading.set(row.heading, list);
    }
    return RELATION_HEADING_ORDER.filter((h) => byHeading.has(h)).map((h) => ({
      heading: h,
      rows: byHeading.get(h) ?? [],
    }));
  }, [rows]);

  function handleRowClick(row: DisplayRow) {
    if (row.crossProjectId) {
      void navigate(`/projects/${row.crossProjectId}/tasks/${row.counterpartId}`);
    } else {
      setSelectedTaskId(row.counterpartId);
    }
  }

  if (error) {
    return (
      <div role="alert" className="text-xs text-semantic-critical px-1 py-2">
        Couldn’t load related tasks. Try reopening the task.
      </div>
    );
  }

  if (isLoading) {
    return <p className="text-xs text-neutral-text-disabled px-1 py-2">Loading related tasks…</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {rows.length === 0 ? (
        <div className="text-sm text-neutral-text-secondary">
          <p>
            No related tasks. Link a task to cross-reference duplicates, blockers, or see-also work.
          </p>
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.heading} aria-label={group.heading}>
            <h4 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
              {group.heading}
            </h4>
            <ul className="flex flex-col">
              {group.rows.map((row) => (
                <RelationRow
                  key={row.relationId}
                  row={row}
                  canEdit={editable}
                  onNavigate={() => handleRowClick(row)}
                  onRemove={() => deleteRel.mutate(row.relationId)}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      {editable && (
        <div>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="inline-flex min-h-11 items-center gap-1 text-sm text-brand-primary hover:underline
              focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 rounded-control"
          >
            <span aria-hidden="true">＋</span> Link task
          </button>
        </div>
      )}

      {pickerOpen && task && (
        <RelatedLinkPicker
          task={task}
          projectId={projectId}
          programId={programId}
          allTasks={tasks ?? []}
          excludedIds={excludedIds}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

interface RelationRowProps {
  row: DisplayRow;
  canEdit: boolean;
  onNavigate: () => void;
  onRemove: () => void;
}

function RelationRow({ row, canEdit, onNavigate, onRemove }: RelationRowProps) {
  // Accessible name carries the relation kind + hex id + name so a screen-reader
  // user hears "Blocked by 000A3F, Foundation" rather than a bare task title.
  const accessibleName = [
    row.heading,
    row.hexId,
    row.name,
    row.crossProjectName ? `in ${row.crossProjectName}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <li className="flex items-center gap-2 border-b border-neutral-border/40 last:border-b-0 py-1.5">
      <button
        type="button"
        onClick={onNavigate}
        aria-label={accessibleName}
        className="flex-1 min-w-0 flex items-center gap-2 text-left rounded-control
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        <span className="tppm-mono text-xs text-neutral-text-disabled shrink-0">
          {row.hexId || '—'}
        </span>
        <span className="flex-1 min-w-0 truncate text-sm text-neutral-text-primary" title={row.name}>
          {row.name}
        </span>
        {row.crossProjectName && (
          <span
            className="shrink-0 text-xs text-neutral-text-secondary px-1.5 py-0.5 rounded-chip bg-neutral-surface-sunken truncate max-w-[8rem]"
            title={row.crossProjectName}
          >
            {row.crossProjectName}
          </span>
        )}
      </button>
      {canEdit && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove relation"
          className="w-6 h-6 shrink-0 flex items-center justify-center rounded-control text-neutral-text-disabled
            hover:text-semantic-critical
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        >
          ×
        </button>
      )}
    </li>
  );
}
