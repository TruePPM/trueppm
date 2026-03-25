/** Shown when the current user's role is below SCHEDULER (role < 2). Rule 94. */
export function PermissionDeniedNotice() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
      <span className="text-2xl" aria-hidden="true">🔒</span>
      <p className="text-sm font-medium text-neutral-text-primary">
        Resource utilization is only visible to Schedulers, Admins, and Owners.
      </p>
      <p className="text-xs text-neutral-text-secondary">
        Contact your project admin to request access.
      </p>
    </div>
  );
}
