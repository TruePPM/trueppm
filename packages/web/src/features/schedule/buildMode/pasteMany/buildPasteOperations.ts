import type { ProjectResource } from '@/types';
import { parseDurationInput } from '../EditableCell';
import { matchRosterMember } from '../ownerToken';
import type { PasteColumnMapping, PasteField } from './inferColumns';
import type { ParsedPasteRow } from './parsePastedText';

export interface PasteCreateOperation {
  op: 'create';
  id: string;
  data: Record<string, unknown>;
}

export interface PasteSummary {
  rowCount: number;
  levelCount: number;
  matchedFields: PasteField[];
  ignoredColumnCount: number;
  needsDurationCount: number;
}

export interface BuiltPasteBatch {
  operations: PasteCreateOperation[];
  summary: PasteSummary;
  /** Every client-minted id this batch created, in row order — the Undo set. */
  createdIds: string[];
  /** Ids created without a resolvable duration — legal, but walkable with F8. */
  needsDurationIds: Set<string>;
  /** Ids this batch gave at least one child — freshly-created summary rows the
   *  outline must auto-expand, or the pasted subtree lands invisible under a
   *  parent that defaults to collapsed. */
  parentIds: Set<string>;
}

/**
 * Turn parsed rows + a column mapping into an ordered `tasks/bulk` create batch.
 *
 * Ids are minted client-side (ADR-0772) and rows are emitted in paste order, so a
 * child row's `parent_id` names its parent's id even though the parent has not
 * reached the server yet — the batch endpoint materializes rows in `operations`
 * order, so by the time a child op runs its parent's INSERT has already committed
 * within the same transaction (`task_bulk.py::_apply_create`).
 *
 * A row with a blank name cell is skipped, not created empty — pasting a ragged
 * block with trailing blank cells must not litter the outline with nameless rows.
 */
export function buildPasteOperations(
  rows: ParsedPasteRow[],
  columns: PasteColumnMapping[],
  resourcePool: ProjectResource[],
  targetParentId: string | null,
  hasHeaderRow: boolean,
  mintId: () => string = () => crypto.randomUUID(),
): BuiltPasteBatch {
  const nameIndex = columns.find((c) => c.field === 'name')?.index ?? 0;
  const durationIndex = columns.find((c) => c.field === 'duration')?.index ?? null;
  const ownerIndex = columns.find((c) => c.field === 'owner')?.index ?? null;
  // The header row named the columns, it did not describe a task — it must never
  // reach the batch as a row of its own (`inferColumns` already excluded it from
  // its own shape-sampling; this is the corresponding exclusion for row building).
  const dataRows = hasHeaderRow ? rows.slice(1) : rows;

  // stack[d] = the client-minted id of the most recent row at depth d - 1 (the
  // parent every depth-d row attaches to). stack[0] is the paste's own target.
  const stack: (string | null)[] = [targetParentId];
  const operations: PasteCreateOperation[] = [];
  const createdIds: string[] = [];
  const needsDurationIds = new Set<string>();
  const parentIds = new Set<string>();
  const depthsUsed = new Set<number>();

  for (const row of dataRows) {
    const name = (row.cells[nameIndex] ?? '').trim();
    if (!name) continue;

    const id = mintId();
    const parentId = stack[row.depth] ?? null;
    if (parentId) parentIds.add(parentId);
    stack[row.depth + 1] = id;
    stack.length = row.depth + 2;
    depthsUsed.add(row.depth);

    const durationRaw = durationIndex != null ? (row.cells[durationIndex] ?? '') : '';
    const duration = durationRaw.trim() ? parseDurationInput(durationRaw) : null;
    if (duration === null) needsDurationIds.add(id);

    const ownerRaw = ownerIndex != null ? (row.cells[ownerIndex] ?? '') : '';
    const owner = ownerRaw.trim() ? matchRosterMember(ownerRaw, resourcePool) : null;

    const data: Record<string, unknown> = { name };
    if (parentId) data.parent_id = parentId;
    if (duration !== null) data.duration = duration;
    if (owner) data.owners = [{ resource: owner.resourceId, units: 1 }];

    operations.push({ op: 'create', id, data });
    createdIds.push(id);
  }

  const matchedFields = columns.map((c) => c.field).filter((f): f is PasteField => f !== null);
  const ignoredColumnCount = columns.filter((c) => c.field === null).length;

  return {
    operations,
    summary: {
      rowCount: createdIds.length,
      levelCount: depthsUsed.size,
      matchedFields,
      ignoredColumnCount,
      needsDurationCount: needsDurationIds.size,
    },
    createdIds,
    needsDurationIds,
    parentIds,
  };
}
