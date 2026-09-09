/**
 * Methodology-aware vocabulary for the program backlog (#3644).
 *
 * ADR-0069 accepted Sarah's (PM) condition on the intake pool verbatim — it
 * "must not force Agile vocabulary on waterfall users" — and then shipped a
 * surface that reads `Program.methodology` nowhere at all. #2619 had already
 * established the pattern on the project side; this is the same pass, one level
 * up.
 *
 * Two different methodologies govern two different questions here, and
 * conflating them is the trap this module exists to prevent:
 *
 *   - The **program's** `effective_methodology` governs authoring (the create
 *     form, the detail view). A `BacklogItem` is program-scoped and has no
 *     project until it is pulled, so there is no other value to read.
 *   - The **target project's** `effectiveMethodology` governs the pull preview.
 *     A HYBRID program can hold a WATERFALL project, so keying the pull copy on
 *     the program would describe the wrong destination for exactly the reader
 *     who most needs it right.
 *
 * `resolveMethodology` centralizes the `?? 'HYBRID'` fallback so an unresolved
 * program query renders the lossless preset rather than flashing agile
 * vocabulary and then swapping it. HYBRID is both the `Program.methodology`
 * model default and the one preset `methodologyTabs` hides nothing under; the
 * same fallback chain is already what `useProgramProjects` applies per project.
 */

import type { Methodology } from '@/types';
import { BACKLOG_ITEM_TYPES, type BacklogItemType } from './types';

/**
 * The preset to render vocabulary for, given a possibly-unresolved server value.
 *
 * Deliberately NOT a `can_*`-style tri-state (web-rule 379): this selects a
 * noun, it does not raise or withhold an affordance, so there is no "safe
 * silent" option — every render must pick some word. HYBRID is the choice
 * because it is the model default and the lossless preset.
 */
export function resolveMethodology(methodology: Methodology | undefined): Methodology {
  return methodology ?? 'HYBRID';
}

/**
 * Visible label for the story-points field.
 *
 * The field itself stays on every methodology — it is wired straight through to
 * `Task.story_points` by the pull service, so hiding it on WATERFALL would drop
 * a real, carried estimate rather than merely rewording it. Only the agile noun
 * goes.
 *
 * Callers must pass this to `StoryPointField`'s `ariaLabel` as well as its
 * `<label>`: the component defaults that prop to "Story points", so leaving it
 * alone would hand a WATERFALL reader a visible "Estimate" whose accessible name
 * is a phrase that appears nowhere on screen (WCAG 2.5.3 Label in Name — a
 * speech-input user saying "Estimate" would match nothing).
 */
export function pointsFieldLabel(methodology: Methodology): string {
  return methodology === 'WATERFALL' ? 'Estimate' : 'Story points';
}

/** The item type a new item starts on. WATERFALL thinks in tasks, not stories. */
export function defaultItemType(methodology: Methodology): BacklogItemType {
  return methodology === 'WATERFALL' ? 'task' : 'story';
}

/**
 * The type options, ordered so the methodology's default leads.
 *
 * The *set* is deliberately identical on every methodology. `item_type` is
 * persisted data, so narrowing the list would make an existing `story` item
 * unrepresentable in its own edit dropdown the moment a program flips to
 * WATERFALL — the same destructive-on-switch defect `pointInputOptions` already
 * guards against by keeping an off-scale legacy value as a trailing option.
 * Only the order moves, which is the rule the AGILE ordering already followed by
 * putting `story` first.
 */
export function itemTypesFor(methodology: Methodology): readonly BacklogItemType[] {
  const lead = defaultItemType(methodology);
  return [lead, ...BACKLOG_ITEM_TYPES.filter((t) => t !== lead)];
}
