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
 *    own bullet, and that bullet is CONDITIONAL: past the project's label soft
 *    cap (`_LABEL_SOFT_CAP_DEFAULT = 50`) `_apply_tags_as_labels` silently skips
 *    coining a new label and the pull still succeeds, so an unconditional "each
 *    tag becomes a label" is a promise the server does not keep. The person
 *    pulling is the one whose tags vanish, and there is no un-pull to correct
 *    it, so the qualifier is theirs to read rather than a curation detail.
 *
 * The literal `•` is the only visible marker — Tailwind's preflight strips
 * `list-style` — but the element is still a real `<ul>`/`<li>`, so a screen
 * reader announces the list marker AND reads the glyph. Each is `aria-hidden`.
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
      <li>
        <span aria-hidden="true">• </span>This item becomes Pulled
      </li>
      {projectMethodology === 'WATERFALL' ? (
        <li>
          <span aria-hidden="true">• </span>New undated task in {target} — on Schedule,
          under Unscheduled
        </li>
      ) : (
        <li>
          <span aria-hidden="true">• </span>New task in {possessive} backlog
        </li>
      )}
      <li>
        <span aria-hidden="true">• </span>Title, description, {pointsNoun}, and type are
        copied
      </li>
      <li>
        <span aria-hidden="true">• </span>Each tag matches a label in {target}, or creates one if
        the project has room (50 characters max)
      </li>
      <li>
        <span aria-hidden="true">• </span>Closing the task closes this item
      </li>
    </ul>
  );
}
