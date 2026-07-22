interface Props {
  notes: string;
  onChange: (next: string) => void;
}

/**
 * The single-author retro Notes field (ADR-0117 §6) — the facilitator's
 * wrap-up summary. Unchanged from the original RetroPanel editor; it is NOT
 * multi-writer (only the sticky columns are). Persisted via the surface's
 * "Save notes & actions" button alongside the action items.
 */
export function RetroNotes({ notes, onChange }: Props) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-text-secondary">Notes</span>
      <textarea
        value={notes}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        maxLength={4000}
        placeholder="Facilitator wrap-up — what the team is taking away…"
        className="px-3 py-2 rounded border border-neutral-border bg-neutral-surface
          text-sm text-neutral-text-primary placeholder:text-neutral-text-secondary resize-y
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      />
    </label>
  );
}
