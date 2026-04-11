/**
 * TaskRunIndicator — subtle spinner badge in the TopBar showing active task runs.
 *
 * Renders only when there is ≥1 active run. Shows a count badge and a spinner.
 * Per VoC feedback: must be subtle and collapsible, not imposing.
 * Hidden when activeCount === 0.
 */
import { useTaskRunStore } from '@/stores/taskRunStore';

export function TaskRunIndicator() {
  const activeCount = useTaskRunStore((s) => s.activeCount);

  if (activeCount === 0) return null;

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-0.5 rounded border border-neutral-border bg-neutral-surface text-xs text-neutral-text-secondary"
      aria-label={`${activeCount} background operation${activeCount > 1 ? 's' : ''} running`}
      role="status"
    >
      {/* Spinner */}
      <svg
        className="w-3 h-3 animate-spin text-brand-primary"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
      <span>{activeCount}</span>
    </div>
  );
}
