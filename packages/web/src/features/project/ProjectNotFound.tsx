import { Link } from 'react-router';

/**
 * Shown by {@link ProjectShell} when the project record 404s — the project was
 * deleted, or the URL is stale/wrong (#1111).
 *
 * Before #1111 a soft-deleted project still resolved on its API endpoints, so
 * the old URL rendered an empty "zombie" overview shell with placeholder dashes.
 * The deleted project now 404s server-side; this surfaces that honestly instead
 * of a blank dashboard, and points the user back to their projects.
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
        It may have been deleted, or the link is out of date. Deleted projects are
        removed from this view along with their tasks.
      </p>
      <Link
        to="/"
        className="inline-flex items-center gap-1 text-sm text-brand-primary hover:underline
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1 rounded"
      >
        <span aria-hidden="true">←</span> Back to your projects
      </Link>
    </div>
  );
}
