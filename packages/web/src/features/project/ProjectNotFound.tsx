import { Link } from 'react-router';
import { FolderIcon } from '@/components/Icons';

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
 *
 * A key URL that does not resolve (ADR-1237) lands here too, with the same copy:
 * the resolver answers "missing" and "not yours" with the same 404 on purpose.
 */
/**
 * Body copy for a key URL opened offline that was never resolved on this device
 * (ADR-1237 UX §3): there is no way to learn what the key points at without the
 * server, and saying "deleted or no access" would assert a cause we do not know.
 */
export const PROJECT_LINK_NEEDS_CONNECTION =
  'This link needs a connection the first time it\u2019s opened.';

const DEFAULT_BODY =
  'It may have been deleted, the link is out of date, or you no longer have access to it. If you expected to see this project, ask a project owner to re-add you.';

export function ProjectNotFound({ body = DEFAULT_BODY }: { body?: string } = {}) {
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-4 py-16 px-6 text-center h-full"
    >
      <FolderIcon aria-hidden="true" className="h-8 w-8 text-neutral-text-secondary" />
      <h2 className="text-base font-medium text-neutral-text-primary">
        This project isn&rsquo;t available
      </h2>
      <p className="text-sm text-neutral-text-secondary max-w-md">{body}</p>
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
