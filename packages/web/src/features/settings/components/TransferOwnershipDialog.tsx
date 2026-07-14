/**
 * Transfer-ownership / transfer-sponsorship confirm dialog (issue 967).
 *
 * Shared modal for the two membership-mutation lifecycle actions wired in this
 * slice: project ownership transfer and program sponsorship transfer. It reuses
 * the rule-160 `MemberPicker` for the new-owner (and optional new-lead) choice
 * and confirms the role reshuffle before firing the mutation. The dialog never
 * mutates directly — the caller passes an `onConfirm` that invokes the wired
 * mutation hook, so the page owns cache invalidation and error surfacing.
 *
 * `role="dialog" aria-modal="true"` with focus on the Cancel (safe) control on
 * open — a transfer is a deliberate, recoverable-only-by-re-transfer hand-off,
 * so the destructive Confirm is never autofocused.
 */

import { useEffect, useRef, useState } from 'react';
import { MemberPicker } from './MemberPicker';

interface TransferOwnershipDialogProps {
  scope: 'project' | 'program';
  scopeId: string | undefined;
  /** Dialog heading, e.g. "Transfer ownership" / "Transfer sponsorship". */
  title: string;
  /** One-line plain-English summary of the role reshuffle. */
  description: string;
  /** Accessible label for the new-owner picker, e.g. "new owner" / "new sponsor". */
  ownerPickerLabel: string;
  /**
   * When set, renders a second optional picker for the program lead/PM. Only the
   * program flow passes this (sponsorship can rotate the program manager too).
   */
  leadPickerLabel?: string;
  /** Server error message to surface inline, or null. */
  error?: string | null;
  busy?: boolean;
  onCancel: () => void;
  /** Fires the wired mutation. `newLeadId` is undefined when no lead picker. */
  onConfirm: (args: { newOwnerId: string; newLeadId?: string }) => void;
}

export function TransferOwnershipDialog({
  scope,
  scopeId,
  title,
  description,
  ownerPickerLabel,
  leadPickerLabel,
  error,
  busy,
  onCancel,
  onConfirm,
}: TransferOwnershipDialogProps) {
  const [newOwnerId, setNewOwnerId] = useState<string | null>(null);
  const [newLeadId, setNewLeadId] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Escape cancels; stopPropagation so it does not bubble to a parent handler
  // (e.g. a settings discard guard) that would also react to the key.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const canConfirm = newOwnerId !== null && !busy;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="transfer-dialog-title"
      aria-describedby="transfer-dialog-body"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="mx-4 w-full max-w-md rounded-card border border-neutral-border bg-neutral-surface p-5 motion-safe:animate-modal-scale-in">
        <h2
          id="transfer-dialog-title"
          className="mb-2 text-sm font-semibold text-neutral-text-primary"
        >
          {title}
        </h2>
        <p id="transfer-dialog-body" className="mb-4 text-xs text-neutral-text-secondary">
          {description}
        </p>

        <div className="mb-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] font-medium text-neutral-text-primary">
              {ownerPickerLabel.charAt(0).toUpperCase() + ownerPickerLabel.slice(1)}
            </span>
            <MemberPicker
              scope={scope}
              scopeId={scopeId}
              value={newOwnerId}
              onChange={setNewOwnerId}
              label={ownerPickerLabel}
              canEdit
            />
          </div>

          {leadPickerLabel ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12px] font-medium text-neutral-text-primary">
                {leadPickerLabel.charAt(0).toUpperCase() + leadPickerLabel.slice(1)}{' '}
                <span className="font-normal text-neutral-text-secondary">(optional)</span>
              </span>
              <MemberPicker
                scope={scope}
                scopeId={scopeId}
                value={newLeadId}
                onChange={setNewLeadId}
                label={leadPickerLabel}
                canEdit
              />
            </div>
          ) : null}
        </div>

        {error ? (
          <p className="mb-3 text-[11px] text-semantic-critical" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="h-8 rounded border border-neutral-border bg-transparent px-3 text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={() => {
              if (newOwnerId === null) return;
              onConfirm({
                newOwnerId,
                newLeadId: leadPickerLabel && newLeadId ? newLeadId : undefined,
              });
            }}
            className={[
              'h-8 rounded border-none px-3 text-[13px] font-medium text-white transition-opacity',
              'bg-brand-primary hover:bg-brand-primary-dark',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary',
              'disabled:cursor-not-allowed disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary',
            ].join(' ')}
          >
            {busy ? 'Transferring…' : 'Confirm transfer'}
          </button>
        </div>
      </div>
    </div>
  );
}
