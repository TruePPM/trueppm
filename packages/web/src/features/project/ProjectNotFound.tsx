import { Link } from 'react-router';

/**
 * Shown by {@link ProjectShell} when the project record is unavailable — it was
 * deleted, the URL is stale/wrong (#1111), or the caller lost access to it (a
 * revoked membership, or a bookmark to a project they were removed from, #2040).
 *
 * These cases are indistinguishable at the API boundary: the detail endpoint is
 * queryset-scoped to the caller's memberships, so both a deleted project and one
 * the caller can no longer see 404 identically. The copy therefore hedges across
 * "deleted or no access" rather than asserting a cause it cannot know — surfacing
 * an honest terminal state (with a way home) instead of a retry treadmill against
 * a resource that will never load.
 */
export function ProjectNotFound() {
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-4 py-16 px-6 text-center h-full"
    >
      <span aria-hidden="true" className="text-3xl">
        🗂️
      </span>
      <h2 className="text-base font-medium text-neutral-text-primary">
        This project isn&rsquo;t available
      </h2>
      <p className="text-sm text-neutral-text-secondary max-w-md">
        It may have been deleted, the link is out of date, or you no longer have access to it. If
        you expected to see this project, ask a project owner to re-add you.
      </p>
      <Link
        to="/"
        className="inline-flex items-center gap-1 text-sm text-brand-primary hover:underline
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1 rounded-control"
      >
        <span aria-hidden="true">←</span> Back to your projects
      </Link>
    </div>
  );
}
