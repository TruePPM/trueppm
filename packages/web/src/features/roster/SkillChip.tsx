import type { Proficiency } from '@/types';
import { PROFICIENCY_LABEL } from '@/types';

interface SkillChipProps {
  name: string;
  proficiency?: Proficiency;
  /** When true, render with a warning color to indicate a missing skill. */
  missing?: boolean;
}

/**
 * The proficiency half of the chip's sentence, on its own: `, Expert`.
 *
 * Exported as a fragment rather than folded into `skillChipLabel` because the
 * chip renders the skill name as real text and completes it with this — so the
 * accessible name the browser computes is `name + this` *by construction*, which
 * is the identity `skillChipLabel` states and the unit tests assert.
 *
 * The separator is a comma, not the em dash this chip's `title` used to carry.
 * That is a correctness constraint, not a style choice: name-from-content
 * concatenates a node's children with each one's leading whitespace trimmed, so
 * an ` — Expert` completion arrives as `React— Expert` — a second, wrong spelling
 * of the same fact, which is exactly the "a fact with three phrasings has no
 * owner" trap in rule 328. A comma needs no leading space, so the computed name
 * is identical to `skillChipLabel`, and it reads better aloud besides.
 */
function proficiencyCompletion(proficiency: Proficiency): string {
  return `, ${PROFICIENCY_LABEL[proficiency]}`;
}

/**
 * The one phrasing of "which skill, and how well" — `React, Expert`.
 *
 * Rule 328's corollary: derive the phrase once and import it into every surface
 * that states it. The chip's `title` and its accessible name both bottom out
 * here, so neither can drift from the other the way the `title` drifted from the
 * (silent) accessible name before #3200.
 */
export function skillChipLabel(name: string, proficiency?: Proficiency): string {
  return proficiency ? `${name}${proficiencyCompletion(proficiency)}` : name;
}

/** Small pill showing a skill name and optional proficiency dots. */
export function SkillChip({ name, proficiency, missing = false }: SkillChipProps) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs border',
        missing
          ? 'border-semantic-critical/40 text-semantic-critical bg-semantic-critical-bg'
          : 'border-neutral-border text-neutral-text-secondary bg-neutral-surface-raised',
      ].join(' ')}
      // Pointer convenience only. It is no longer the sole carrier of the
      // proficiency, which is the whole point of #3200.
      title={skillChipLabel(name, proficiency)}
    >
      {name}
      {proficiency && <ProficiencyDots level={proficiency} />}
      {/* Proficiency, stated at rest (#3200). Before this it lived in the `title`
          above and in the dots below, and the dots are `aria-hidden` — so a touch
          user got nothing (a `title` has no touch affordance) and a screen-reader
          user got the bare skill name. Rule 328(b): "a fact stated only in a
          `title` or an `aria-label` is not stated."

          An `sr-only` completion in this element rather than an `aria-label` on
          it: a label REPLACES the name rather than extending it, so the chip
          would announce "Expert" with no subject and the skill — the thing the
          chip exists to name — would be the fact that went missing.

          The dots stay the visual channel and the word is not drawn. This chip is
          the one place the word does not fit: four of them plus two "Missing:"
          chips share a single option row in a dropdown the width of the task
          drawer, and `Intermediate` is longer than most skill names. Where there
          is a column for it the tree already draws the word — see
          `RosterDetailPanel`'s skills list, which renders `PROFICIENCY_LABEL`
          as visible text at one-skill-per-row density. */}
      {proficiency && (
        <span className="sr-only">{proficiencyCompletion(proficiency)}</span>
      )}
    </span>
  );
}

/** Three dots: filled up to `level`, empty thereafter. */
export function ProficiencyDots({ level }: { level: Proficiency }) {
  return (
    <span aria-hidden="true" className="inline-flex gap-0.5">
      {([1, 2, 3] as const).map((n) => (
        <span
          key={n}
          className={[
            'w-1 h-1 rounded-full',
            n <= level ? 'bg-brand-primary' : 'bg-neutral-border',
          ].join(' ')}
        />
      ))}
    </span>
  );
}
