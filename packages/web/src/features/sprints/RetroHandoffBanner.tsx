interface Props {
  /** Name of the just-closed sprint, shown in the CTA copy and label. */
  sprintName: string;
  /** Lowercase iteration noun (e.g. "sprint" / "iteration") for supporting copy. */
  iterationLabel: string;
  /** Deep-link the just-closed sprint's retro surface into view. */
  onRun: () => void;
  /** Dismiss the handoff without opening the retro. */
  onDismiss: () => void;
}

/**
 * Post-close retro handoff CTA (issue 1471).
 *
 * The retro→backlog pipeline is strong, but the retro was orphaned from the
 * ceremony that launches it: closing a sprint dropped the user back at the top
 * of the workspace with no signpost to the retro board sitting far below. This
 * banner appears on close success and hands the team one tap into the
 * just-closed sprint's retro while it is still fresh.
 *
 * It is `role="status"` (a polite live region, not an alert) because it is a
 * success handoff — it never gates the close, and the dismiss control lets the
 * team opt out entirely.
 */
export function RetroHandoffBanner({
  sprintName,
  iterationLabel,
  onRun,
  onDismiss,
}: Props) {
  return (
    <div
      role="status"
      className="mx-6 mt-2 rounded-card border border-brand-primary/30 bg-brand-primary/5
        px-3 py-2 text-xs flex items-center justify-between gap-3"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span aria-hidden="true" className="text-brand-primary font-semibold">
          ✓
        </span>
        <p className="text-neutral-text-primary truncate">
          <span className="font-medium">{sprintName}</span> closed.{' '}
          <span className="text-neutral-text-secondary">
            Run its retro while the {iterationLabel} is still fresh.
          </span>
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onRun}
          className="h-7 px-2.5 rounded text-xs font-medium
            border border-brand-primary/40 bg-brand-primary/10 text-brand-primary
            hover:bg-brand-primary/20
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Run the {sprintName} retro →
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss retro handoff"
          className="h-7 w-7 grid place-items-center rounded text-neutral-text-secondary
            hover:bg-neutral-surface-raised
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </div>
  );
}
