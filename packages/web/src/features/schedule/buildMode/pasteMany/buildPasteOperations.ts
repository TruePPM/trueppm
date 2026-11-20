import type { ProjectResource } from '@/types';
import { parseDurationInput } from '../EditableCell';
import {
  DEFAULT_OWNER_PERCENT,
  ownerTokensToApiPayload,
  parseAllocationPercent,
  resolveRosterMember,
  type RosterMatch,
} from '../ownerToken';
import { classifyPertTriple } from '@/lib/pertTriple';
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
  /** Header text of each unmatched column ("column N" when it has none), so the
   *  receipt can name what the client did not recognize. Never a permission verdict. */
  ignoredColumnNames: string[];
  needsDurationCount: number;
  /** Rows whose Owner cell named nobody on the roster — a typo or a stale person.
   *  Counted separately from `ambiguousOwnerCount` because the repairs differ. */
  unmatchedOwnerCount: number;
  /** Rows whose Owner cell named more than one roster member, e.g. `Ana` against
   *  both "Ana Rivera" and "Ana Silva". */
  ambiguousOwnerCount: number;
  /** Rows that carried a three-point cell but not a usable all-or-none, ordered triple
   *  — created without any estimate rather than with a partial one the server rejects. */
  droppedEstimateCount: number;
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
  /** Rows created without the owner their cell asked for, with the text that failed
   *  and why. The receipt reports the two reasons as separate counts; the row ids are
   *  carried so a later change can walk to them the way F8 walks `needsDurationIds`,
   *  which this deliberately does not wire (#2905; follow-up #3033). */
  droppedOwners: DroppedOwner[];
}

export interface DroppedOwner {
  /** The client-minted id of the row whose owner was dropped. */
  id: string;
  /** The Owner cell exactly as pasted, so the author can find it in their source. */
  value: string;
  reason: 'unmatched' | 'ambiguous';
}

interface PasteColumnIndices {
  /** Column 0 when nothing claimed `name` — a block with no header still has to build. */
  nameIndex: number;
  durationIndex: number | null;
  ownerIndex: number | null;
  unitsIndex: number | null;
  /** Optimistic / most likely / pessimistic columns; all null when none is mapped. */
  pertIndices: [number | null, number | null, number | null];
}

function columnIndices(columns: PasteColumnMapping[]): PasteColumnIndices {
  return {
    nameIndex: columns.find((c) => c.field === 'name')?.index ?? 0,
    durationIndex: columns.find((c) => c.field === 'duration')?.index ?? null,
    ownerIndex: columns.find((c) => c.field === 'owner')?.index ?? null,
    unitsIndex: columns.find((c) => c.field === 'units')?.index ?? null,
    pertIndices: [
      columns.find((c) => c.field === 'optimistic')?.index ?? null,
      columns.find((c) => c.field === 'most_likely')?.index ?? null,
      columns.find((c) => c.field === 'pessimistic')?.index ?? null,
    ],
  };
}

/** An unmapped field and a ragged row short of that column read the same: blank. */
function cellAt(row: ParsedPasteRow, index: number | null): string {
  return index != null ? (row.cells[index] ?? '') : '';
}

function resolveRowDuration(row: ParsedPasteRow, durationIndex: number | null): number | null {
  const raw = cellAt(row, durationIndex);
  return raw.trim() ? parseDurationInput(raw) : null;
}

/** One estimate cell: blank -> null, unparseable -> NaN (present but unusable). */
function resolvePertCell(row: ParsedPasteRow, index: number | null): number | null {
  const raw = cellAt(row, index);
  if (!raw.trim()) return null;
  return parseDurationInput(raw) ?? Number.NaN;
}

function resolveRowOwner(ownerRaw: string, pool: ProjectResource[]): RosterMatch | null {
  return ownerRaw.trim() ? resolveRosterMember(ownerRaw, pool) : null;
}

function buildRowData(
  name: string,
  parentId: string | null,
  duration: number | null,
  owner: RosterMatch | null,
  unitsPercent: number | null,
  pert: { o: number; m: number; p: number } | null,
): Record<string, unknown> {
  const data: Record<string, unknown> = { name };
  if (parentId) data.parent_id = parentId;
  if (duration !== null) data.duration = duration;
  if (pert) {
    data.optimistic_duration = pert.o;
    data.most_likely_duration = pert.m;
    data.pessimistic_duration = pert.p;
  }
  if (owner?.member) {
    // Percent in, fraction out, through the one converter that owns that step
    // (`ownerTokensToApiPayload` — see its docstring). Writing `units` inline here is
    // what left every pasted row at a hard-coded 1.0 while `@ana:50` worked correctly
    // one keystroke away (#3102); a second conversion site is how that comes back.
    data.owners = ownerTokensToApiPayload([
      {
        resourceId: owner.member.resourceId,
        name: owner.member.resource.name,
        units: unitsPercent ?? DEFAULT_OWNER_PERCENT,
      },
    ]);
  }
  return data;
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
  const { nameIndex, durationIndex, ownerIndex, unitsIndex, pertIndices } =
    columnIndices(columns);
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
  const droppedOwners: DroppedOwner[] = [];
  const depthsUsed = new Set<number>();
  let droppedEstimateCount = 0;

  for (const row of dataRows) {
    const name = (row.cells[nameIndex] ?? '').trim();
    if (!name) continue;

    const id = mintId();
    const parentId = stack[row.depth] ?? null;
    if (parentId) parentIds.add(parentId);
    stack[row.depth + 1] = id;
    stack.length = row.depth + 2;
    depthsUsed.add(row.depth);

    const duration = resolveRowDuration(row, durationIndex);
    if (duration === null) needsDurationIds.add(id);

    const ownerRaw = cellAt(row, ownerIndex);
    // An owner the roster cannot resolve is still dropped from the payload — the
    // server rejects an off-roster id and binding the wrong person is worse than
    // binding none (ADR-0774 §3). What changes here is that the drop is now
    // *recorded* rather than silent: `matchRosterMember` collapsed "nobody" and
    // "several people" to the same null, so neither reached the receipt (#2905).
    const owner = resolveRowOwner(ownerRaw, resourcePool);
    if (owner && owner.status !== 'matched') {
      droppedOwners.push({ id, value: ownerRaw.trim(), reason: owner.status });
    }

    // Blank or unparseable allocation is not an error — it means the row said nothing
    // about allocation, and `buildRowData` falls back to 100%. Only an owner-bearing
    // row consumes it; an allocation with nobody to apply it to is dropped with the
    // column's other orphans rather than inventing an assignment.
    const unitsPercent = parseAllocationPercent(cellAt(row, unitsIndex));

    // All-or-none, ordered (the server's rule): a partial or unordered triple is dropped
    // whole and counted, never sent half — the row still lands, without an estimate.
    const triple = classifyPertTriple(
      resolvePertCell(row, pertIndices[0]),
      resolvePertCell(row, pertIndices[1]),
      resolvePertCell(row, pertIndices[2]),
    );
    if (triple.kind === 'incomplete' || triple.kind === 'out_of_order') droppedEstimateCount++;

    operations.push({
      op: 'create',
      id,
      data: buildRowData(
        name,
        parentId,
        duration,
        owner,
        unitsPercent,
        triple.kind === 'ok' ? triple : null,
      ),
    });
    createdIds.push(id);
  }

  const matchedFields = columns.map((c) => c.field).filter((f): f is PasteField => f !== null);
  const ignoredColumns = columns.filter((c) => c.field === null);
  const ignoredColumnCount = ignoredColumns.length;
  const ignoredColumnNames = ignoredColumns.map((c) => c.header?.trim() || `column ${c.index + 1}`);

  return {
    operations,
    summary: {
      rowCount: createdIds.length,
      levelCount: depthsUsed.size,
      matchedFields,
      ignoredColumnCount,
      ignoredColumnNames,
      needsDurationCount: needsDurationIds.size,
      unmatchedOwnerCount: droppedOwners.filter((o) => o.reason === 'unmatched').length,
      ambiguousOwnerCount: droppedOwners.filter((o) => o.reason === 'ambiguous').length,
      droppedEstimateCount,
    },
    createdIds,
    needsDurationIds,
    parentIds,
    droppedOwners,
  };
}
