import { useCallback, useMemo, useState } from 'react';
import type { ProjectResource, Task } from '@/types';
import { toast } from '@/components/Toast';
import { useBulkCreateTasks, useBulkDeleteTasks } from '@/hooks/useTaskMutations';
import { useWbsStore } from '@/stores/wbsStore';
import { buildPasteOperations, type PasteSummary } from './buildPasteOperations';
import { inferColumns, looksLikeHeaderRow, type PasteColumnMapping } from './inferColumns';
import { parsePastedText, type ParsedPasteRow } from './parsePastedText';

export interface PasteReceiptState {
  summary: PasteSummary;
  /** Ids the batch actually applied — the Undo set. Narrower than every id the
   *  client minted: a row can be rejected (e.g. the milestone-parent guard) and
   *  never land. */
  createdIds: string[];
  needsDurationIds: Set<string>;
  parsedRows: ParsedPasteRow[];
  columns: PasteColumnMapping[];
  hasHeaderRow: boolean;
}

/**
 * Orchestrates paste-many end to end (#2724): parse clipboard text, infer
 * hierarchy + columns, submit as one `tasks/bulk` batch, and hold the receipt
 * state the strip / F8 walk / "Map columns…" remap all read from.
 */
export function usePasteMany({
  projectId,
  resourcePool,
  allTasks,
  focusedRowId,
  onFocusRow,
}: {
  projectId: string | null;
  resourcePool: ProjectResource[];
  allTasks: Task[];
  focusedRowId: string | null;
  onFocusRow: (id: string) => void;
}) {
  const bulkCreate = useBulkCreateTasks(projectId);
  const bulkDelete = useBulkDeleteTasks(projectId);
  const [receipt, setReceipt] = useState<PasteReceiptState | null>(null);
  const [isUndoing, setIsUndoing] = useState(false);
  const [mappingDialogOpen, setMappingDialogOpen] = useState(false);

  // Paste-many appends at the end of the focused row's own parent's children —
  // same "sibling, same depth" convention as Enter (`insertBelow`, #1666) — so a
  // paste while sitting on a row extends that row's level rather than nesting
  // under it. Nothing focused pastes at the project root.
  const targetParentId = useMemo(() => {
    if (!focusedRowId) return null;
    return allTasks.find((t) => t.id === focusedRowId)?.parentId ?? null;
  }, [focusedRowId, allTasks]);

  const commit = useCallback(
    (parsedRows: ParsedPasteRow[], columns: PasteColumnMapping[], hasHeaderRow: boolean) => {
      const built = buildPasteOperations(
        parsedRows,
        columns,
        resourcePool,
        targetParentId,
        hasHeaderRow,
      );
      if (built.operations.length === 0) {
        toast.error("Nothing to paste — every row's name cell was blank.");
        return;
      }
      bulkCreate.mutate(built.operations, {
        onSuccess: (res) => {
          const appliedIds = new Set(
            res.applied.filter((entry) => entry.op === 'create').map((entry) => entry.id),
          );
          const createdIds = built.createdIds.filter((id) => appliedIds.has(id));
          const needsDurationIds = new Set(
            [...built.needsDurationIds].filter((id) => appliedIds.has(id)),
          );
          if (createdIds.length === 0) {
            toast.error("Couldn't paste those rows — try again.");
            return;
          }
          setReceipt({
            summary: {
              ...built.summary,
              rowCount: createdIds.length,
              needsDurationCount: needsDurationIds.size,
            },
            createdIds,
            needsDurationIds,
            parsedRows,
            columns,
            hasHeaderRow,
          });
          // A newly-created summary row starts collapsed (`useWbsStore`'s default),
          // so without this the pasted subtree would land invisible under its own
          // just-created parent — a paste that silently "disappeared".
          useWbsStore.getState().expand(built.parentIds);
          onFocusRow(createdIds[0]);
        },
        onError: () => toast.error("Couldn't paste those rows — try again."),
      });
    },
    [bulkCreate, resourcePool, targetParentId, onFocusRow],
  );

  const handlePaste = useCallback(
    (text: string): boolean => {
      const parsedRows = parsePastedText(text);
      if (parsedRows.length < 2) return false;
      const hasHeaderRow = looksLikeHeaderRow(parsedRows[0]?.cells ?? []);
      const columns = inferColumns(parsedRows, hasHeaderRow);
      commit(parsedRows, columns, hasHeaderRow);
      return true;
    },
    [commit],
  );

  const undo = useCallback(() => {
    if (!receipt) return;
    setIsUndoing(true);
    bulkDelete.mutate(receipt.createdIds, {
      onSuccess: () => {
        setIsUndoing(false);
        setReceipt(null);
      },
      onError: () => {
        setIsUndoing(false);
        toast.error("Couldn't undo the paste — try again.");
      },
    });
  }, [receipt, bulkDelete]);

  const keep = useCallback(() => setReceipt(null), []);
  const openMapColumns = useCallback(() => setMappingDialogOpen(true), []);
  const closeMapColumns = useCallback(() => setMappingDialogOpen(false), []);

  /** Undo the current paste, then re-submit the same rows under a corrected mapping. */
  const applyColumnMapping = useCallback(
    (newColumns: PasteColumnMapping[]) => {
      if (!receipt) return;
      setMappingDialogOpen(false);
      bulkDelete.mutate(receipt.createdIds, {
        onSuccess: () => commit(receipt.parsedRows, newColumns, receipt.hasHeaderRow),
        onError: () => toast.error("Couldn't update the column mapping — try again."),
      });
    },
    [receipt, bulkDelete, commit],
  );

  return {
    handlePaste,
    receipt,
    needsDurationIds: receipt?.needsDurationIds ?? EMPTY_ID_SET,
    isUndoing,
    isPasting: bulkCreate.isPending,
    undo,
    keep,
    mappingDialogOpen,
    openMapColumns,
    closeMapColumns,
    applyColumnMapping,
  };
}

const EMPTY_ID_SET: ReadonlySet<string> = new Set();
