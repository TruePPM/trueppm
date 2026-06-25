/**
 * The team-owned "raise the ceiling" confirm (ADR-0104 §1.1).
 *
 * Raising a ceiling authorizes *wider* exposure, so it is never a silent PATCH: it
 * is framed as a team decision (recorded + announced), it does NOT move the dial
 * now, and it nudges the retro as the home of the decision. Lowering goes through a
 * separate, immediate path (more private is always safe).
 */

import { useState } from 'react';
import {
  AUDIENCE_RUNG_LABEL_FULL,
  SIGNAL_AUDIENCE_LADDER,
  audienceRank,
  type SignalAudience,
} from './useSignalPrivacy';

interface RaiseCeilingDialogProps {
  signalTitle: string;
  currentCeiling: SignalAudience;
  onConfirm: (ceiling: SignalAudience) => void;
  onCancel: () => void;
}

export function RaiseCeilingDialog({
  signalTitle,
  currentCeiling,
  onConfirm,
  onCancel,
}: RaiseCeilingDialogProps) {
  // Only rungs strictly above the current ceiling are raise targets.
  const options = SIGNAL_AUDIENCE_LADDER.filter(
    (rung) => audienceRank(rung) > audienceRank(currentCeiling),
  );
  const [target, setTarget] = useState<SignalAudience>(options[0]);

  return (
    <div
      role="alertdialog"
      aria-label={`Raise the ceiling for ${signalTitle}`}
      className="mb-4 rounded-card border border-neutral-border bg-neutral-surface-raised p-4"
    >
      <h4 className="text-[13px] font-semibold text-neutral-text-primary">
        Raise the ceiling for {signalTitle}?
      </h4>
      <p className="mt-1 text-[12px] text-neutral-text-secondary">
        This authorizes {signalTitle.toLowerCase()} to be shared as far as:
      </p>
      <div role="radiogroup" className="mt-2 space-y-1">
        {options.map((rung) => (
          <label
            key={rung}
            className="flex items-center gap-2 text-[12px] text-neutral-text-primary"
          >
            <input
              type="radio"
              name="raise-ceiling-target"
              value={rung}
              checked={target === rung}
              onChange={() => setTarget(rung)}
            />
            {AUDIENCE_RUNG_LABEL_FULL[rung]}
          </label>
        ))}
      </div>
      <p className="mt-3 text-[12px] text-neutral-text-secondary">
        ⚠ This is a team decision. It will be recorded in the project history and announced to the
        team. It does not change who sees {signalTitle.toLowerCase()} right now — it only allows the
        Scrum Master to move the dial up to here.
      </p>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-7 rounded border border-neutral-border px-3 text-[12px] font-medium text-neutral-text-secondary hover:bg-neutral-surface-sunken"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onConfirm(target)}
          className="h-7 rounded bg-brand-primary px-3 text-[12px] font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Raise ceiling
        </button>
      </div>
    </div>
  );
}
