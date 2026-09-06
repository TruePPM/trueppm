import { useCallback, useMemo, useState } from 'react';
import axios from 'axios';
import { useClassifySubtree, type ClassificationApply } from '@/hooks/useTaskClassification';
import { useUndoCascadeClassificationOperation, describeUndo } from '@/hooks/useBatchOperations';
import { describeWriteRefusal, type WriteRefusal } from '@/lib/writeRefusal';
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

/**
 * A refused cascade, as the popover must present it (#3302).
 *
 * A record rather than a string because the button label is part of the answer.
 * The endpoint refuses three distinct ways — a 403 naming how many rows the
 * caller's role cannot author, a 400 `subtree_too_large` carrying the counts, and
 * the 400 graph guard — and each is a decision the server has already made, so
 * replaying the identical request is refused identically. A "Retry" offered there
 * points at the one action guaranteed not to help.
 *
 * All three sentences are the server's own, rendered verbatim. The graph guard's
 * used to read as a raw id list; it now names the offending tasks by WBS code and
 * name, resolved where the refusal is raised (#3333), so every consumer of the
 * endpoint gets it rather than only the surface holding the task array. That also
 * means it is bounded server-side to stay under {@link MAX_MESSAGE_LENGTH} — a
 * longer sentence would be discarded here for the generic fallback.
 */
export type ClassificationError = WriteRefusal;

/** Shown only when the failure carries no readable server message (offline, opaque 5xx). */
export const CLASSIFICATION_FALLBACK = "Couldn't apply the classification.";

export interface ClassificationPopoverController {
  /** Open state, including the anchor the caller computed. `null` when closed. */
  state: { taskId: string; anchor: { x: number; y: number } } | null;
  /** The subtree root, resolved against `tasks`. `null` when closed or not found. */
  target: Task | null;
  isPending: boolean;
  /** The refusal for the popover's inline error slot, or `null`. */
  error: ClassificationError | null;
  open: (taskId: string, anchor: { x: number; y: number }) => void;
  close: () => void;
  apply: (spec: ClassificationApply) => void;
}

/**
 * Project a failed cascade onto what the popover renders.
 *
 * Pure and exported so the three refusal shapes can be driven through it
 * directly — passing a finished string in as a prop tests the slot, not the
 * wiring, which is how all three collapsed to one sentence unnoticed (#3302).
 *
 * The shaping itself is {@link describeWriteRefusal}, shared with the eight
 * other write surfaces that had each reinvented it (#3332); what stays here is
 * the only part that is genuinely about classification — this endpoint's
 * fallback sentence and its `subtree_too_large` remedy.
 */
export function describeClassificationError(error: unknown): ClassificationError | null {
  return describeWriteRefusal(error, CLASSIFICATION_FALLBACK, structuredDetail);
}

/** What the planner can do about a cap refusal — the client's half of the message. */
const SUBTREE_TOO_LARGE_REMEDY = 'Classify a smaller branch, or turn off “Cascade to descendants”.';

/**
 * The client's second line for a refusal that carries structured fields.
 *
 * Only `subtree_too_large` has one, and it is the **remedy**, not a re-narration:
 * the server's `matched`/`max` exist "for a client that wants to branch without
 * parsing the sentence" (its own comment), and `detail` already states both
 * counts as prose — repeating them doubles the reading length of the one message
 * the user is stuck on.
 *
 * The counts are still echoed when the sentence does not carry them, so a
 * reworded `detail` can never leave the planner without the numbers they need to
 * pick a smaller branch. DRF serializes both as strings (an int member of a
 * `ValidationError` detail is a type error there), so they are echoed, never used
 * as arithmetic.
 */
function structuredDetail(error: unknown, message: string): string | null {
  if (!axios.isAxiosError(error)) return null;
  const data: unknown = error.response?.data;
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (record.code !== 'subtree_too_large') return null;
  const matched = readCount(record.matched);
  const max = readCount(record.max);
  if (matched === null || max === null) return SUBTREE_TOO_LARGE_REMEDY;
  if (message.includes(matched) && message.includes(max)) return SUBTREE_TOO_LARGE_REMEDY;
  return `${matched} tasks matched — the cap is ${max}. ${SUBTREE_TOO_LARGE_REMEDY}`;
}

/**
 * The receipt's headline count, in the unit the planner selected (#3306).
 *
 * The old copy read `${governance.applied + delivery_mode.applied} fields written
 * across ${matched} rows`, and that first number was none of the three things it
 * could have been. `applied` increments once per row PER AXIS, and the governance
 * branch writes two model columns per increment — so a 10-row both-axes cascade
 * announced "20 fields written across 10 rows" having written 30 columns. It was
 * axis-rows, a unit with no meaning outside the server's own tally loop and nothing
 * the planner could check against the grid.
 *
 * Rows is the unit they chose: they pointed at a subtree and the grid shows rows.
 * `rows_written` is the server's own count of rows it saved, so the two numbers here
 * are both verifiable — how many rows the subtree resolved, and how many of them
 * moved. Which axes moved is already stated by the `parts` clause ahead of this one,
 * so the receipt names only units the planner supplied.
 *
 * Written and matched are collapsed to one number when they agree, because
 * "10 of 10 rows" reads as a caveat where there is none. They disagree whenever a
 * milestone was skipped, an override was kept, or a row already held the requested
 * value — including the whole-subtree no-op, which says "0 of 10 rows reclassified"
 * rather than going quiet.
 *
 * Both branches pluralize off `matched`, and the fallback's singular is reachable
 * rather than defensive: `cascade: false` resolves the root alone, so re-applying a
 * class that root already holds is `0 of 1 row`.
 */
function describeRowsWritten(rowsWritten: number, matched: number): string {
  if (rowsWritten === matched) {
    return `${rowsWritten} row${rowsWritten === 1 ? '' : 's'} reclassified`;
  }
  return `${rowsWritten} of ${matched} row${matched === 1 ? '' : 's'} reclassified`;
}

/** A count as the server sent it, tolerating both the string DRF emits and a raw number. */
function readCount(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
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
            const kept = report.governance?.overrides_kept ?? 0;
            const detail = [
              describeRowsWritten(report.rows_written, report.matched),
              kept > 0 ? `${kept} governance override${kept === 1 ? '' : 's'} kept` : null,
              report.skipped.length > 0
                ? `${report.skipped.length} milestone${report.skipped.length === 1 ? '' : 's'} left alone`
                : null,
            ]
              .filter(Boolean)
              .join(' · ');
            // Two conditions, and they answer different questions (#3304).
            // `operation_id` is null when the cascade wrote nothing, so there is
            // no ledger row to reverse. `can_undo` is the server's verdict on
            // whether THIS caller's role may reverse one at all — apply is
            // `IsProjectPlanAuthor` and the undo endpoint is Admin+, so a Member
            // reaches this success handler and would 403 on the click. The toast
            // is the only route to that undo and it lives 8 seconds, so a control
            // offered here and refused there is unrecoverable: omit it, the way
            // `SeedBanner` omits its Admin-only controls rather than disabling
            // them. The server still enforces; this only stops the false offer.
            const operationId = report.can_undo ? report.operation_id : null;
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

  const classifyError = classifyMut.error;
  const error = useMemo(() => describeClassificationError(classifyError), [classifyError]);

  return {
    state,
    target,
    isPending: classifyMut.isPending,
    error,
    open,
    close,
    apply,
  };
}
