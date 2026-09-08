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
 * `remedy` is required rather than defaulted (web rule 409): the sentence telling
 * the reader what to do is a claim about the *caller's* affordances, not this
 * component's. `ResourceView` has a window nav and a resource filter; the program
 * Contention page has neither, so hardcoding one sentence for both would send
 * half the readers looking for controls that are not there.
 *
 * The cap sits above the supported project size, so in practice this renders
 * only for a project already outside the documented envelope.
 */
interface Props {
  /** Resources in scope on the server, before the cap. */
  resourceCount: number;
  /** Resources actually present in the response. */
  shownCount: number;
  /**
   * What the reader can do about it *on this surface*. Must name a control that
   * actually exists here — see the note above.
   */
  remedy: string;
}

export function AllocationTruncationNotice({ resourceCount, shownCount, remedy }: Props) {
  const hidden = Math.max(0, resourceCount - shownCount);
  return (
    <div
      role="status"
      className="rounded-card border border-semantic-warning/40 bg-semantic-warning-bg px-4 py-3 text-sm text-semantic-warning"
    >
      Showing {shownCount} of {resourceCount} resources. There are more people assigned here
      than this view can show at once, so {hidden}{' '}
      {hidden === 1 ? 'resource is' : 'resources are'} not listed. {remedy}
    </div>
  );
}
