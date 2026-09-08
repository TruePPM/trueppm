/**
 * Notice shown when the server capped an allocation or contention read (ADR-1118).
 *
 * The server bounds these endpoints at a fixed number of assignment rows and cuts
 * on a resource boundary, so every resource it *did* return carries all of its
 * spans and its client-side overallocation verdict (ADR-0031) is exact. What is
 * missing is whole people — which is precisely what a view about who is
 * over-committed must not conceal. Without this notice the roster reads as
 * complete and the omission is invisible.
 *
 * The cap sits above the supported project ceiling, so in practice this renders
 * only for a project already outside the documented envelope.
 */
interface Props {
  /** Resources in scope on the server, before the cap. */
  resourceCount: number;
  /** Resources actually present in the response. */
  shownCount: number;
}

export function AllocationTruncationNotice({ resourceCount, shownCount }: Props) {
  const hidden = Math.max(0, resourceCount - shownCount);
  return (
    <div
      role="status"
      className="mx-4 mt-3 rounded-card border border-semantic-warning/40 bg-semantic-warning-bg px-4 py-3 text-sm text-semantic-warning"
    >
      Showing {shownCount} of {resourceCount} resources. This project has more assignments
      than a single response carries, so {hidden} {hidden === 1 ? 'resource is' : 'resources are'}{' '}
      not listed. Narrow the window or filter to specific resources to see them.
    </div>
  );
}
