interface GridEmptyStateProps {
  /** Optional CTA — typically opens the unified TaskFormModal in create mode. */
  onAddTask?: () => void;
}

/** Shared empty state for all three Grid modes when the project has zero tasks. */
export function GridEmptyState({ onAddTask }: GridEmptyStateProps) {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-3 bg-neutral-surface px-4"
    >
      <p className="text-sm text-neutral-text-primary font-medium">No tasks yet</p>
      <p className="text-xs text-neutral-text-secondary text-center max-w-xs">
        Add your first task to get started.
      </p>
      {onAddTask && (
        <button
          type="button"
          onClick={onAddTask}
          className="
            h-7 px-3 text-xs font-medium rounded
            border border-brand-primary bg-brand-primary text-white
            hover:bg-brand-primary-dark
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1
          "
        >
          + Add task
        </button>
      )}
    </div>
  );
}

/** Filtered-empty state for Flat / Grouped / Outline when filters yield zero rows. */
export function GridFilteredEmptyState({ onClear }: { onClear: () => void }) {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-3 bg-neutral-surface"
    >
      <p className="text-sm text-neutral-text-primary font-medium">
        No tasks match these filters
      </p>
      <button
        type="button"
        onClick={onClear}
        className="
          text-xs text-brand-primary underline
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1
        "
      >
        Clear filters
      </button>
    </div>
  );
}
