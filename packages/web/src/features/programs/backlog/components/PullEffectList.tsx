/**
 * The shared "what will happen" bullets for a pull, rendered identically by the
 * desktop pull-confirm pane and the mobile pull sheet. Extracted so the copy
 * lives in one place (it drifted between the two surfaces before #1996).
 *
 * Two of the four original bullets were wrong, and #3644 fixes both:
 *
 * 1. **"tags … are copied over" was false.** `_apply_tags_as_labels` converts
 *    each tag into a project `Label` — find-or-create against a *different*,
 *    project-scoped, curated collection, matched case-insensitively and clamped
 *    to 50 characters. That is a conversion into another entity, not a copy of a
 *    field, and it creates project vocabulary other people will see. It gets its
 *    own bullet. The label soft cap (past which a new tag is silently skipped) is
 *    deliberately NOT here: it is a project-admin curation concern, not a
 *    decision the person pulling is making, and a sixth bullet would cost more
 *    attention than the case is worth.
 * 2. **"New task in X's backlog" named a tab WATERFALL does not render.**
 *    `methodologyTabs` hides `product-backlog` *and* `sprints` on WATERFALL, so
 *    on a schedule-first project the promise pointed at nothing. The task lands
 *    at `status=BACKLOG` with no planned start, which is exactly the Schedule's
 *    Unscheduled tray predicate (`useUnscheduledTasks`) — so that is where it
 *    actually shows up, and that is what this now says.
 *
 * The methodology term is the **target project's**, never the program's: a
 * HYBRID program can hold a WATERFALL project, and keying this copy on the
 * program would describe the wrong destination for precisely the reader who most
 * needs it right.
 *
 * The disclosure lives here rather than on the success toast on purpose. The
 * toast auto-dismisses and there is no un-pull endpoint, so a pointer that
 * disappears on its own is the wrong host for "where did this go" (web-rule
 * 373(f) — put it on the standing surface that commits the act). The toast's
 * "Go to task" deep-link answers a different question and is unchanged: this
 * says where work of this kind lands, the toast says where this one went.
 */

import type { Methodology } from '@/types';
import { pointsFieldLabel } from '../methodologyVocabulary';

interface PullEffectListProps {
  /** Target project name, when a project is selected — personalizes the copy. */
  projectName: string | null;
  /**
   * The target project's resolved methodology, when one is selected. Absent
   * until then, and the copy stays methodology-neutral rather than guessing a
   * destination it cannot back up.
   */
  projectMethodology?: Methodology;
  className?: string;
}

export function PullEffectList({
  projectName,
  projectMethodology,
  className = '',
}: PullEffectListProps) {
  const target = projectName ?? 'the project';
  const possessive = projectName ? `${projectName}'s` : 'the project';
  // Lowercased so it reads mid-sentence; the same term the create form uses, so
  // a WATERFALL reader is not told their "Estimate" arrives as "story points".
  const pointsNoun = projectMethodology
    ? pointsFieldLabel(projectMethodology).toLowerCase()
    : 'story points';

  return (
    <ul className={`space-y-1 text-xs leading-relaxed text-neutral-text-secondary ${className}`}>
      <li>• This item becomes Pulled</li>
      {projectMethodology === 'WATERFALL' ? (
        <li>• New undated task in {target} — on Schedule, under Unscheduled</li>
      ) : (
        <li>• New task in {possessive} backlog</li>
      )}
      <li>• Title, description, {pointsNoun}, and type are copied</li>
      <li>• Each tag matches or creates a label in {target} (50 characters max)</li>
      <li>• Closing the task closes this item</li>
    </ul>
  );
}
