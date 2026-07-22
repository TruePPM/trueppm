interface Props {
  /** Outcome-language detail from the server's guardrail_blocked error. */
  detail: string;
  /** Acknowledge and clear the block notice. */
  onDismiss: () => void;
}

/**
 * Blocking guardrail notice (ADR-0101 Tier 2).
 *
 * Shown when a project Owner has escalated a sprint-composition rule to a hard
 * block: the assignment was rejected and the task's sprint was never changed.
 * Unlike {@link GuardrailNotice} there is NO "override anyway" — a block is
 * resolved only by removing the offending state (e.g. assigning the child tasks
 * instead of the phase). Uses `role="alert"` because, unlike a warn, this is an
 * outcome the user must act on.
 */
export function GuardrailBlock({ detail, onDismiss }: Props) {
  return (
    <div
      role="alert"
      className="rounded-card border-l-2 border-semantic-critical bg-sem-critical-bg px-3 py-2 space-y-2"
    >
      <div className="flex items-start gap-1.5 text-xs text-neutral-text-primary">
        <span aria-hidden="true" className="text-semantic-critical leading-4">
          ⊘
        </span>
        <span>{detail}</span>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="min-h-[44px] md:min-h-0 md:h-8 px-3 rounded-control text-xs font-medium
          border border-neutral-border text-neutral-text-primary hover:bg-neutral-surface-raised
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        Got it
      </button>
    </div>
  );
}
