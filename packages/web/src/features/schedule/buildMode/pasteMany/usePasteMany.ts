import { useCallback, useMemo, useState } from 'react';
import type { ProjectResource, Task } from '@/types';
import { toast } from '@/components/Toast';
import { useUndoPasteManyOperation } from '@/hooks/useBatchOperations';
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
  /**
   * The ⌘Z undo ledger row for this paste (ADR-0810, #2756) — null only if the
   * batch somehow created rows but the server didn't record one (should not
   * happen in practice; `undo` falls back to the raw client-side delete then).
   */
  operationId: string | null;
  /**
   * The server's verdict on whether THIS caller may reverse the paste (#3353,
   * web rule 373). `false` for a Member: `tasks/bulk/` is `IsProjectPlanAuthor`
   * but `/paste-many-operations/{id}/undo/` is Admin+, so the batch commits and
   * the undo 403s.
   *
   * Held separately from `operationId` on purpose — that answers "is there
   * anything to undo", this answers "may you", and the strip needs both. Folding
   * them would make a null `operationId` mean either, and it already carries the
   * client-side-delete fallback below.
   *
   * Carried tri-state (`boolean | undefined`) rather than normalized here, per rule
   * 379: the strip reads it for an affordance AND for a disclosure, and those have
   * opposite safe defaults. Collapsing it at this boundary would force one of them.
   */
  canUndo: boolean | undefined;
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
  const bulkCreate = useBulkCreateTasks(projectId, 'paste');
  const bulkDelete = useBulkDeleteTasks(projectId);
  const undoOperation = useUndoPasteManyOperation(projectId);
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
            operationId: res.operation_id,
            canUndo: res.can_undo,
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
    // #3353: unless the server has affirmatively said this caller may reverse the
    // batch, neither route below can be trusted — the ledger undo 403s, and the raw
    // client-side delete is not the same act (it would discard rows a colleague
    // has since edited, which the ledger undo deliberately keeps). The strip omits
    // the control and ⌘Z is unbound, so this is defense in depth rather than the
    // gate; keeping it means no future caller can reintroduce the false offer by
    // wiring a new button straight to `undo`.
    if (receipt.canUndo !== true) return;
    setIsUndoing(true);
    // ADR-0810 (#2756): the server-recorded ledger, not a raw client-side
    // bulk-delete — it skips any row a person has since touched (e.g. typed a
    // real name over "Row 3" before deciding to undo) rather than discarding it.
    // Falls back to the old raw delete only in the should-not-happen case where
    // the create response carried no operation id.
    if (receipt.operationId) {
      undoOperation.mutate(receipt.operationId, {
        onSuccess: (data) => {
          setIsUndoing(false);
          setReceipt(null);
          if (data.undo.kept > 0) {
            toast.info(`Undid the paste — kept ${data.undo.kept} row(s) you'd already touched.`);
          }
        },
        onError: () => {
          setIsUndoing(false);
          toast.error("Couldn't undo the paste — try again.");
        },
      });
      return;
    }
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
  }, [receipt, bulkDelete, undoOperation]);

  const keep = useCallback(() => setReceipt(null), []);
  const openMapColumns = useCallback(() => setMappingDialogOpen(true), []);
  const closeMapColumns = useCallback(() => setMappingDialogOpen(false), []);

  /**
   * Undo the current paste, then re-submit the same rows under a corrected mapping.
   *
   * Deliberately the raw client-side `bulkDelete`, not `undoOperation` — this is an
   * internal delete-then-recommit step, never exposed as an "Undo" the user can
   * reach for later, and `commit` mints a fresh ledger row for the recommit
   * regardless. Routing it through the server undo would only add a request; the
   * old ledger row is left orphaned but harmless (its rows are gone, so undoing it
   * later is a no-op the purge job clears in time).
   *
   * Deliberately NOT gated on `receipt.canUndo` (#3353). That flag is the caller's
   * authority over `/paste-many-operations/{id}/undo/`; this path never touches that
   * endpoint, and deleting rows the caller just created is within the plan-authoring
   * rights they already used to create them. Gating it would take "Map columns…"
   * away from every Member, which is a capability they have.
   */
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
