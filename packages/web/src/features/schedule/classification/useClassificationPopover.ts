import { useCallback, useMemo, useState } from 'react';
import { useClassifySubtree, type ClassificationApply } from '@/hooks/useTaskClassification';
import { useUndoCascadeClassificationOperation, describeUndo } from '@/hooks/useBatchOperations';
import type { Task } from '@/types';

/**
 * The classification-cascade popover's controller — open/apply/undo, minus the UI.
 *
 * Extracted from `ScheduleView` when the backlog grew the same entry point (#3035).
 * The Schedule was the only surface that could declare a hybrid split, but an agile
 * project *lands* on `/product-backlog` (ADR-0800 §3), so the PO who most needs to
 * mark a compliance subtree was the one person who could not reach it. Two surfaces
 * now open the same popover, and this hook is the reason there is still one
 * definition of what applying it means.
 *
 * What is deliberately NOT in here: the anchor rect and the keybinding. Both are
 * surface-specific — the Schedule anchors to a virtualized row and falls back when
 * that row is scrolled out; the backlog anchors to a card that is always in the DOM.
 */

/** Where the confirmation goes. Each surface owns its own toast channel. */
export interface ClassificationAnnouncement {
  message: string;
  durationMs: number;
  action?: { label: string; onClick: () => void };
}

export interface ClassificationPopoverController {
  /** Open state, including the anchor the caller computed. `null` when closed. */
  state: { taskId: string; anchor: { x: number; y: number } } | null;
  /** The subtree root, resolved against `tasks`. `null` when closed or not found. */
  target: Task | null;
  isPending: boolean;
  /** A message for the popover's inline error slot, or `null`. */
  error: string | null;
  open: (taskId: string, anchor: { x: number; y: number }) => void;
  close: () => void;
  apply: (spec: ClassificationApply) => void;
}

export function useClassificationPopover({
  projectId,
  tasks,
  readOnly,
  announce,
}: {
  projectId: string | undefined;
  tasks: Task[];
  readOnly: boolean;
  announce: (announcement: ClassificationAnnouncement) => void;
}): ClassificationPopoverController {
  // `anchor` is captured from the row's own rect at open time rather than tracked
  // live: the popover is modalless but short-lived, and re-anchoring it on every
  // scroll tick would make it chase the row out from under the cursor mid-choice.
  const [state, setState] = useState<{
    taskId: string;
    anchor: { x: number; y: number };
  } | null>(null);
  const classifyMut = useClassifySubtree();
  const { reset: resetClassifyMut } = classifyMut;
  const undoClassifyMut = useUndoCascadeClassificationOperation(projectId ?? null);

  const open = useCallback(
    (taskId: string, anchor: { x: number; y: number }) => {
      if (readOnly) return;
      resetClassifyMut();
      setState({ taskId, anchor });
    },
    [readOnly, resetClassifyMut],
  );

  const close = useCallback(() => setState(null), []);

  const target = useMemo(
    () => (state ? (tasks.find((t) => t.id === state.taskId) ?? null) : null),
    [state, tasks],
  );

  // ADR-0810 (#2756): reverses one cascade via its operation ledger — the server
  // skips any row reclassified again since (e.g. a second cascade, or a person
  // hand-editing the axis) rather than blindly stomping it.
  const undoClassify = useCallback(
    (operationId: string) => {
      undoClassifyMut.mutate(operationId, {
        onSuccess: (data) => announce({ message: describeUndo(data.undo), durationMs: 8000 }),
        onError: () => announce({ message: "Couldn't undo the cascade.", durationMs: 8000 }),
      });
    },
    [undoClassifyMut, announce],
  );

  /**
   * Render the server's own report, not the client's preview.
   *
   * The preview predicted what would happen; this states what did. They agree in
   * every case the mirror is correct, and when they don't, the receipt is the one
   * that is true — which is why the message is built from `report` and never from
   * the popover's state.
   */
  const apply = useCallback(
    (spec: ClassificationApply) => {
      if (!projectId) return;
      classifyMut.mutate(
        { projectId, ...spec },
        {
          onSuccess: (report) => {
            setState(null);
            const parts: string[] = [];
            if (report.governance) parts.push(`governance → ${report.governance.requested}`);
            if (report.delivery_mode) parts.push(`delivery → ${report.delivery_mode.requested}`);
            const written =
              (report.governance?.applied ?? 0) + (report.delivery_mode?.applied ?? 0);
            const kept = report.governance?.overrides_kept ?? 0;
            const detail = [
              `${written} field${written === 1 ? '' : 's'} written across ${report.matched} row${report.matched === 1 ? '' : 's'}`,
              kept > 0 ? `${kept} governance override${kept === 1 ? '' : 's'} kept` : null,
              report.skipped.length > 0
                ? `${report.skipped.length} milestone${report.skipped.length === 1 ? '' : 's'} left alone`
                : null,
            ]
              .filter(Boolean)
              .join(' · ');
            const operationId = report.operation_id;
            announce({
              message: `Classified: ${parts.join(', ')} — ${detail}.`,
              durationMs: 8000,
              action: operationId
                ? { label: 'Undo', onClick: () => undoClassify(operationId) }
                : undefined,
            });
          },
        },
      );
    },
    [projectId, classifyMut, announce, undoClassify],
  );

  return {
    state,
    target,
    isPending: classifyMut.isPending,
    error: classifyMut.error !== null ? 'Could not apply the classification.' : null,
    open,
    close,
    apply,
  };
}
