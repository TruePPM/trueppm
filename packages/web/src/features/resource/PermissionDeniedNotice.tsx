/** Shown when the current user's role is below SCHEDULER (role < ROLE_SCHEDULER). Rule 94. */
import { LockIcon } from '@/components/Icons';

export function PermissionDeniedNotice() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
      <LockIcon className="h-6 w-6" aria-hidden="true" />
      <p className="text-sm font-medium text-neutral-text-primary">
        Resource utilization is only visible to Schedulers, Admins, and Owners.
      </p>
      <p className="text-xs text-neutral-text-secondary">
        Contact your project admin to request access.
      </p>
    </div>
  );
}
