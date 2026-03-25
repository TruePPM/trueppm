/**
 * Shown when the API returns HTTP 409 (schedule not run — no CPM dates). Rule 95.
 * Provides a CTA to trigger the scheduler.
 */
interface Props {
  onRunScheduler: () => void;
}

export function ResourceEmptyState({ onRunScheduler }: Props) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-6">
      <div
        className="w-12 h-12 rounded-full bg-neutral-surface-raised flex items-center justify-center"
        aria-hidden="true"
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-neutral-text-secondary"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18" />
          <path d="M9 4v5" />
          <path d="M15 4v5" />
        </svg>
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-neutral-text-primary">
          Schedule not yet computed
        </p>
        <p className="text-xs text-neutral-text-secondary">
          Run the scheduler to see resource utilization.
        </p>
      </div>
      <button
        type="button"
        onClick={onRunScheduler}
        className="
          border border-brand-primary/40 rounded h-7 px-3 text-xs font-medium
          bg-brand-primary/10 text-brand-primary
          hover:bg-brand-primary/20
          focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
        "
      >
        Run Scheduler
      </button>
    </div>
  );
}
