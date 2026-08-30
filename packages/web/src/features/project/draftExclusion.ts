/**
 * The one phrase naming what a draft plan is held out of (#2962, #3129).
 *
 * Derived once and imported by every surface that states it — the header's draft
 * line and the commit confirm sheet — because a fact with three phrasings has no
 * owner (web-rule 328). It had three here: the pill's `title` listed four
 * aggregates, the visible line listed three, and the sheet listed four in a
 * different order, so the one channel a sighted touch user could actually reach
 * was the one missing My Work.
 *
 * Each of the four is a real server-side exclusion, not a description of intent:
 * `projects/lifecycle.py` owns the predicate and `program_rollup.py`,
 * `program_views.py`, the omni-search source in `views.py` and the `/me/work`
 * capacity source in `services.py` each apply it.
 */
export const DRAFT_EXCLUDED_AGGREGATES = 'program rollup, portfolio health, search and My Work';

/** The header's at-rest statement of the draft's consequence. */
export const DRAFT_EXCLUSION_SENTENCE = `A draft is held out of ${DRAFT_EXCLUDED_AGGREGATES} until the plan is committed.`;
