import { useNavigate } from 'react-router';

export interface MethodologyMismatchBannerProps {
  /** The "Review methodology" action routes relative to this — inert while absent. */
  projectId: string | null | undefined;
  /**
   * The whole sentence, composed by the call site.
   *
   * Deliberately not derived from the methodology inside this component. The
   * visibility matrix already lives in exactly one place
   * (`methodologyTabs.ts`), and `hiddenViewsForMethodology`'s docstring records
   * what happens when a second surface re-states it in prose: the #2619 flip
   * warning hard-coded "sprints" while the matrix already hid `product-backlog`
   * alongside it, and said nothing about the two views AGILE hides. A
   * `switch (methodology)` here would be a third copy of the same fact. Each
   * call site owns its own noun — the same contract `MethodologyEmptyState`
   * already uses for `title`/`description`, and what keeps the eslint
   * iteration-label gate able to see `itl.*` at the site that needs it.
   */
  message: string;
  /** Surface rhythm (margins). This component ships no outer margin of its own. */
  className?: string;
}

/**
 * States that real work exists on a view the project's methodology preset hides
 * from the nav (issue #2619, reopened by the 2026-08-31 audit's finding A).
 *
 * The sibling `MethodologyEmptyState` covers the *empty* half of the same
 * defect, and until this component was extracted every mismatch signal in the
 * product was gated on emptiness — so the worst case had no signal on either
 * path: an AGILE flip on a project with a real CPM schedule, or a WATERFALL flip
 * on a groomed backlog, rendered the ordinary populated view with nothing
 * indicating the surface now sits outside the project's workflow. A flip never
 * touches the data it hides, so this is the only thing that tells a team its
 * committed work is now reachable by URL alone.
 *
 * Read-only and **not dismissible**: it is a statement of the project's current
 * configuration, not an event, and it removes itself the moment either half
 * stops being true (the methodology is flipped back, or the rows are gone). A
 * dismiss control on a persistent-truth disclosure teaches the reader to clear
 * it, after which the surface gives no signal again — which is the defect. The
 * dismissible banners nearby (`CapacityWarningsAlert`, the backlog conflict
 * notice) report a *moment*, which is why they differ.
 *
 * Tone is `semantic-at-risk`, not the calm `EmptyState` anatomy its sibling
 * uses: the empty case has nothing at stake, while here the project's data and
 * its configuration disagree and nothing else in the product will say so. Not
 * `semantic-critical` — nothing failed and nothing is lost.
 *
 * Callers must gate on **resolved** data (web rule 392): `[]`/`0` while a query
 * is in flight or after it failed is "unknown", never "nothing to guard
 * against". Where a surface has a filter, gate on the *unfiltered* count — this
 * is a statement about the project, not about the active filter (rule 388).
 */
export function MethodologyMismatchBanner({
  projectId,
  message,
  className,
}: MethodologyMismatchBannerProps) {
  const navigate = useNavigate();
  return (
    <div
      // Polite, never `alert`: the mismatch is a standing condition, not an
      // interruption. Mounted with the surface, so it does not announce on load;
      // it does announce if it appears mid-session (a flip arriving over WS).
      role="status"
      className={`rounded-card border border-semantic-at-risk/40 bg-semantic-at-risk-bg
    text-semantic-at-risk px-3 py-2 text-xs flex items-center justify-between gap-3 flex-wrap${
      className ? ` ${className}` : ''
    }`}
    >
      <p>{message}</p>
      <button
        type="button"
        onClick={() =>
          projectId && void navigate(`/projects/${projectId}/settings#how-this-team-works`)
        }
        // `min-h-11` (44px) only below `md`: the row wraps on a phone and the
        // button becomes a standalone touch target there. Desktop keeps the
        // shipped text-link height. `md:` — not `sm:` — matches the touch-target
        // convention already in the tree (`WorkspaceEmailPage`,
        // `ProjectGuardrailsPage`), and `md` is the breakpoint `useBreakpoint`
        // uses to switch these surfaces to their mobile components.
        className="shrink-0 min-h-11 md:min-h-0 inline-flex items-center text-xs font-semibold underline hover:no-underline
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-at-risk focus-visible:ring-offset-1 rounded"
      >
        Review methodology
      </button>
    </div>
  );
}
