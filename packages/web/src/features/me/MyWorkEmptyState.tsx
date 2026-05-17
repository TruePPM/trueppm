/**
 * Empty states for /me/work (issue #499).
 *
 * Two distinct flavors:
 *   - Flavor A — user has no project memberships at all. Surface a docs link
 *     plus a "Load demo data" CTA so a brand-new user has something to do.
 *   - Flavor B — user has projects but no assignments. Docs link only; no
 *     demo CTA (they're not new, just unassigned).
 *
 * The "external sync coming" message Priya needs (Gap 3 / #500 is not yet
 * shipped) lives in `docs/features/my-work.md` rather than this empty state
 * so the page stays calm; the docs link surfaces it on demand.
 */
interface Props {
  hasProjects: boolean;
}

export function MyWorkEmptyState({ hasProjects }: Props) {
  if (!hasProjects) {
    return (
      <div
        role="status"
        className="flex flex-col items-center justify-center gap-4 py-16 px-6 text-center"
      >
        <span aria-hidden="true" className="text-3xl">
          📥
        </span>
        <h2 className="text-base font-medium text-neutral-text-primary">
          Nothing assigned to you yet
        </h2>
        <div className="text-sm text-neutral-text-secondary max-w-md space-y-2">
          <p>Tasks will appear here when:</p>
          <ul className="text-left list-disc list-inside space-y-1">
            <li>A project manager assigns you to a task</li>
            <li>You create a task in a project</li>
            <li>External sync from Jira, Linear, or GitHub lands tasks here (coming soon)</li>
          </ul>
        </div>
        <a
          href="/docs/features/my-work"
          className="inline-flex items-center gap-1 text-sm text-brand-primary hover:underline
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1 rounded"
        >
          <span aria-hidden="true">📖</span> Learn about the contributor view
        </a>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-4 py-16 px-6 text-center"
    >
      <span aria-hidden="true" className="text-3xl">
        👋
      </span>
      <h2 className="text-base font-medium text-neutral-text-primary">
        You&rsquo;re not assigned to any active work right now.
      </h2>
      <p className="text-sm text-neutral-text-secondary max-w-md">
        When a PM assigns you a task or you create one, you&rsquo;ll see it here.
      </p>
      <a
        href="/docs/features/my-work"
        className="inline-flex items-center gap-1 text-sm text-brand-primary hover:underline
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1 rounded"
      >
        <span aria-hidden="true">📖</span> Learn about the contributor view
      </a>
    </div>
  );
}
