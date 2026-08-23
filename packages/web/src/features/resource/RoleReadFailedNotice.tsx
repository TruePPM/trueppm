/**
 * Shown when the membership read itself failed — NOT a permission verdict.
 *
 * `useCurrentUserRole` returns `role: null` for two different situations, "no
 * membership" and "the request failed", and it sets `retry: false`, so one blip is
 * enough. Rendering the denial notice for the second case tells a Scheduler or Owner
 * they lack access they hold, and a permission wall is *actionable* — they go and ask
 * a colleague for a role they already have (rule 246, #2998).
 *
 * The copy therefore has to do two things the denial notice must not: name this as a
 * failed request rather than a decision, and offer a way out.
 */
import { WarningIcon } from '@/components/Icons';

export function RoleReadFailedNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center h-full gap-3 text-center px-6"
    >
      <WarningIcon className="h-6 w-6 text-semantic-critical" aria-hidden="true" />
      <p className="text-sm font-medium text-neutral-text-primary">
        Couldn&rsquo;t check your role on this project.
      </p>
      <p className="text-xs text-neutral-text-secondary">
        This is a failed request, not a permission decision — your access is unchanged.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="px-3 py-1.5 rounded-control border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
      >
        Try again
      </button>
    </div>
  );
}
