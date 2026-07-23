import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/Button';
import { ListIcon } from '@/components/Icons';

interface GridEmptyStateProps {
  /** Optional CTA — typically opens the unified TaskFormModal in create mode. */
  onAddTask?: () => void;
}

/** Shared empty state for all three Grid modes when the project has zero tasks. */
export function GridEmptyState({ onAddTask }: GridEmptyStateProps) {
  return (
    <EmptyState
      className="h-full bg-neutral-surface"
      icon={ListIcon}
      title="No tasks yet"
      description="Add your first task to get started — it will appear here and across every view."
      action={onAddTask ? <Button onClick={onAddTask}>+ Add task</Button> : undefined}
    />
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
      {/* Standalone button: focus: (not focus-visible:) so the ring shows on
          pointer-initiated focus in Firefox/Safari (rule 214, WCAG 2.4.7). */}
      <button
        type="button"
        onClick={onClear}
        className="
          text-xs text-brand-primary underline
          focus:outline-none focus:ring-2 focus:ring-brand-primary
          focus:ring-offset-1
        "
      >
        Clear filters
      </button>
    </div>
  );
}
