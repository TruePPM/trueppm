/**
 * Confirm dialog for the dead-letter write actions (issue 695, ADR-0210).
 *
 * One component drives all four operator actions — requeue / drop, single / bulk:
 *  - **requeue** shows an operator-chosen backoff select; the primary confirm
 *    re-enqueues via the durable workflow backend (server-side).
 *  - **drop** shows an optional audit-note textarea and a danger-styled confirm;
 *    it soft-removes the task (→ dismissed) but retains the row for audit.
 *
 * `role="alertdialog"` with `useFocusTrap` (web-rule 206): autofocuses the first
 * focusable (the backoff select / note textarea — the destructive confirm is
 * never autofocused), wraps Tab, and routes Escape to cancel. Confirmation of a
 * destructive/bulk action is required before the mutation fires; the caller owns
 * the mutation and passes `busy`/`error` back for the button state and inline alert.
 */

import { useId, useState } from 'react';
import { Button } from '@/components/Button';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { BACKOFF_OPTIONS } from '@/hooks/useFailedTaskActions';

export type DeadLetterActionKind = 'requeue' | 'drop';

export interface DeadLetterActionDialogProps {
  kind: DeadLetterActionKind;
  /** When set, the action is bulk over the current filter set (N = matched count). */
  bulkCount?: number;
  /** Task name shown for a single-task action (omitted for bulk). */
  taskName?: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  /** Fires the wired mutation. Reads `backoffSeconds` for requeue, `note` for drop. */
  onConfirm: (opts: { backoffSeconds: number; note: string }) => void;
}

export function DeadLetterActionDialog({
  kind,
  bulkCount,
  taskName,
  busy,
  error,
  onCancel,
  onConfirm,
}: DeadLetterActionDialogProps) {
  // Escape is busy-guarded to match the backdrop-click guard: dismissing the
  // dialog mid-mutation would hide the in-flight action (and, on error, the
  // inline alert). Passing no onEscape while busy makes Escape inert.
  const trapRef = useFocusTrap<HTMLDivElement>(true, busy ? undefined : onCancel);
  const [backoffSeconds, setBackoffSeconds] = useState<number>(0);
  const [note, setNote] = useState<string>('');
  const fieldId = useId();

  const isBulk = typeof bulkCount === 'number';
  const isRequeue = kind === 'requeue';

  const title = isRequeue
    ? isBulk
      ? `Requeue ${bulkCount} task${bulkCount === 1 ? '' : 's'}?`
      : 'Requeue task?'
    : isBulk
      ? `Drop ${bulkCount} task${bulkCount === 1 ? '' : 's'}?`
      : 'Drop task?';

  const body = isRequeue
    ? isBulk
      ? `Every dead or pending task in the current filter will be re-enqueued through the durable workflow backend (bounded per run).`
      : `This task will be re-enqueued through the durable workflow backend with the chosen backoff.`
    : isBulk
      ? `Every task in the current filter will be removed from the active queue. The records are kept for audit — they are not deleted.`
      : `This task will be removed from the active queue. The record is kept for audit — it is not deleted.`;

  const confirmLabel = isRequeue
    ? isBulk
      ? busy
        ? 'Requeuing…'
        : `Requeue ${bulkCount}`
      : busy
        ? 'Requeuing…'
        : 'Requeue'
    : isBulk
      ? busy
        ? 'Dropping…'
        : `Drop ${bulkCount}`
      : busy
        ? 'Dropping…'
        : 'Drop';

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={`${fieldId}-title`}
      aria-describedby={`${fieldId}-body`}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={trapRef}
        className="mx-4 w-full max-w-sm rounded-card border border-neutral-border bg-neutral-surface p-5 motion-safe:animate-modal-scale-in"
      >
        <h2 id={`${fieldId}-title`} className="mb-2 text-sm font-semibold text-neutral-text-primary">
          {title}
        </h2>
        {taskName && (
          <p className="mb-2 tppm-mono text-[11px] text-neutral-text-secondary break-all">
            {taskName}
          </p>
        )}
        <p id={`${fieldId}-body`} className="mb-4 text-xs text-neutral-text-secondary">
          {body}
        </p>

        {isRequeue ? (
          <div className="mb-4">
            <label
              htmlFor={fieldId}
              className="mb-1.5 block text-[12px] font-medium text-neutral-text-primary"
            >
              Backoff
            </label>
            <select
              id={fieldId}
              value={backoffSeconds}
              onChange={(e) => setBackoffSeconds(Number(e.target.value))}
              disabled={busy}
              className="h-8 w-full rounded-control border border-neutral-border bg-neutral-surface-raised px-2.5 text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:opacity-50"
            >
              {BACKOFF_OPTIONS.map((opt) => (
                <option key={opt.seconds} value={opt.seconds}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="mb-4">
            <label
              htmlFor={fieldId}
              className="mb-1.5 block text-[12px] font-medium text-neutral-text-primary"
            >
              Note <span className="font-normal text-neutral-text-secondary">(optional)</span>
            </label>
            <textarea
              id={fieldId}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
              rows={3}
              maxLength={1000}
              placeholder="Why is this being dropped? (recorded in the audit trail)"
              className="w-full resize-none rounded-control border border-neutral-border bg-neutral-surface-raised px-2.5 py-2 text-[13px] text-neutral-text-primary placeholder:text-neutral-text-disabled focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:opacity-50"
            />
          </div>
        )}

        {error && (
          <p role="alert" className="mb-3 text-xs text-semantic-critical">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={isRequeue ? 'primary' : 'danger'}
            size="sm"
            onClick={() => onConfirm({ backoffSeconds, note: note.trim() })}
            disabled={busy}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
