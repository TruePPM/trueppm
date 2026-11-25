import { useState } from 'react';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useSlipReasonPromptStore } from '@/stores/slipReasonPromptStore';

const PRIMARY_BTN =
  'h-8 px-3 rounded bg-brand-primary text-neutral-text-inverse text-[13px] font-medium border-none hover:bg-brand-primary-dark disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary focus-visible:outline-none';
const SECONDARY_BTN =
  'h-8 px-3 rounded border border-neutral-border bg-transparent text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none';

/**
 * Host for the commitment-slip reason prompt (ADR-1485 D1). Mounted once in the
 * app shell; renders only while {@link useSlipReasonPromptStore} is open.
 */
export function SlipReasonDialog() {
  const open = useSlipReasonPromptStore((s) => s.open);
  if (!open) return null;
  return <SlipReasonDialogBody />;
}

function SlipReasonDialogBody() {
  const settle = useSlipReasonPromptStore((s) => s.settle);
  const [reason, setReason] = useState('');
  const cancel = () => settle(null);
  const trapRef = useFocusTrap<HTMLDivElement>(true, cancel, false);
  const trimmed = reason.trim();

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="slip-reason-title"
        aria-describedby="slip-reason-body"
        tabIndex={-1}
        className="bg-neutral-surface border border-neutral-border rounded-card w-full max-w-sm mx-4 p-5 focus:outline-none"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed) settle(trimmed);
          }}
        >
          <h2 id="slip-reason-title" className="text-[15px] font-semibold text-neutral-text-primary">
            Move past the sprint end?
          </h2>
          <p id="slip-reason-body" className="mt-2 text-[13px] text-neutral-text-secondary">
            This moves committed work past the end of the active sprint. Say why, so the
            sprint keeps a record of the change.
          </p>
          <label
            htmlFor="slip-reason-input"
            className="mt-3 block text-[13px] font-medium text-neutral-text-primary"
          >
            Reason
          </label>
          <textarea
            id="slip-reason-input"
            value={reason}
            maxLength={500}
            rows={3}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full rounded border border-neutral-border bg-neutral-surface p-2 text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className={SECONDARY_BTN} onClick={cancel}>
              Keep dates
            </button>
            <button type="submit" className={PRIMARY_BTN} disabled={!trimmed}>
              Move it
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
