/**
 * Stub backlog tab — placeholder shown until #501 (BacklogItem) lands.
 *
 * Intentional: the tab is visible so users learn it's coming, but the body is
 * static text + a single link to ADR-0069 rather than skeletons or an empty
 * grid (which would imply functionality that doesn't yet exist).
 */
export function ProgramBacklogStubPage() {
  return (
    <div className="mx-auto max-w-xl px-6 py-12 text-center">
      <h2 className="text-base font-semibold text-neutral-text-primary">
        The program backlog is coming next
      </h2>
      <p className="mt-3 text-sm text-neutral-text-secondary">
        A shared pool of cross-project work &mdash; features, stories, and tasks that any
        project in this program can pull from.
      </p>
      <p className="tppm-mono mt-2 text-xs text-neutral-text-secondary">
        Tracked in issue #501 &middot; ETA next release.
      </p>
      <a
        href="https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0069-dual-level-backlog-program-backlog-item-and-project-backlog.md"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-6 inline-block text-sm font-medium text-brand-primary underline
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        Read the design (ADR-0069)
      </a>
    </div>
  );
}
