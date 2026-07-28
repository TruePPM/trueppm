import { ArrowRightIcon } from '@/components/Icons';
import { docsUrl } from '@/lib/docsUrl';

/**
 * Context-sensitive help deep-link for the "no committed start" flag (#2484):
 * the docs section explaining what a committed start actually does to the CPM
 * pass, why an in-progress task without one is flagged, and when leaving a task
 * on computed dates is the right answer.
 *
 * Why a component and not an inline `<a>`: the flag is surfaced twice — the
 * Schedule row chip popover (#2313) and the drawer advisory (#2314) — and those
 * two already share their predicate ({@link isMissingCommittedStart}) and their
 * write path ({@link useCommitStartOrTodo}). The help path is the third thing
 * that must never drift between them, for the same reason {@link ForecastBasisHelp}
 * exists: a second mount point should be an import, not a paste.
 *
 * Deliberately *not* a {@link FieldHelp}: both call sites are already a popover
 * or an advisory panel, so the explanation is on screen — what is missing is the
 * way out to the full treatment, which is FieldHelp's footer link on its own.
 * Nesting a second help popover inside the first would add a layer without
 * adding an answer.
 *
 * Renders for viewers as well as editors. The `canEdit` gate at the call sites
 * covers the two *remediations* (web-rules 156/272 — never show an action that
 * will 403); understanding what you are looking at is not a permission.
 */
export function HowDatesWorkLink({ className = '' }: { className?: string }) {
  return (
    <a
      href={docsUrl('features/schedule/#committed-vs-computed-start-dates')}
      target="_blank"
      rel="noopener noreferrer"
      // `min-h-11` gives a real 44px touch target on a phone (rule 5), relaxed
      // at `md:` where the popover is pointer-driven and the row would otherwise
      // add dead height. Anchors keep `focus-visible:` (rule 4) — a clicked link
      // navigates away rather than retaining focus, so the rule-214 standalone-
      // trigger carve-out does not apply.
      className={`inline-flex min-h-11 items-center gap-1 rounded text-xs font-medium text-brand-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 md:min-h-0 ${className}`}
    >
      How dates work
      <span className="sr-only"> (opens in a new tab)</span>
      <ArrowRightIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    </a>
  );
}
