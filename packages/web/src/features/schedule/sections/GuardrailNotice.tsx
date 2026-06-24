import { useState } from 'react';
import type { GuardrailWarning } from '@/hooks/useTaskMutations';

interface Props {
  /** Warn-level guardrails the server flagged on the (already-succeeded) write. */
  warnings: GuardrailWarning[];
  /** Revert the assignment (re-PATCH the prior value). */
  onUndo: () => void;
  /** Dismiss the notice, keeping the assignment. Records the override. */
  onKeep: (reason: string) => void;
}

/**
 * Non-blocking guardrail notice (ADR-0101 Tier 1).
 *
 * The assignment has ALREADY succeeded — this is the override surface, not a
 * gate. `role="status"` + `aria-live="polite"` (never `role="alert"`, which is
 * reserved for blocks): a warn must not interrupt a screen-reader user mid-task.
 *
 * Copy comes from the server in OUTCOME language ("double-counts in velocity"),
 * never WBS jargon. The reason field is always optional and one-tap-skippable —
 * no policy tier may require it at the warn level (frontend/CLAUDE.md rule).
 */
export function GuardrailNotice({ warnings, onUndo, onKeep }: Props) {
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState('');

  if (warnings.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-card border-l-2 border-semantic-at-risk bg-sem-at-risk-bg px-3 py-2 space-y-2"
    >
      <ul className="space-y-1">
        {warnings.map((w) => (
          <li key={w.rule} className="flex items-start gap-1.5 text-xs text-neutral-text-primary">
            <span aria-hidden="true" className="text-semantic-at-risk leading-4">
              ◆
            </span>
            <span>{w.detail}</span>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onKeep(reason)}
          className="min-h-[44px] sm:min-h-0 sm:h-8 px-3 rounded-control text-xs font-medium
            border border-neutral-border text-neutral-text-primary hover:bg-neutral-surface-raised
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Keep it here
        </button>
        <button
          type="button"
          onClick={onUndo}
          className="min-h-[44px] sm:min-h-0 sm:h-8 px-3 rounded-control text-xs font-medium
            text-neutral-text-secondary hover:text-neutral-text-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Undo
        </button>
      </div>

      {showReason ? (
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Add a note (optional)"
          aria-label="Override note (optional)"
          className="w-full h-8 rounded-control border border-neutral-border bg-neutral-surface px-2 text-xs
            text-neutral-text-primary placeholder:text-neutral-text-secondary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowReason(true)}
          className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-control"
        >
          ▸ Add a note (optional)
        </button>
      )}
    </div>
  );
}
