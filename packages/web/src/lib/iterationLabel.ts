/**
 * Iteration-container label forms (ADR-0111, #862).
 *
 * The project stores a single *singular* noun for its time-boxed iteration
 * container (`Project.iteration_label`: "Sprint" default, or "Iteration" / "PI" /
 * a custom string). The UI needs several grammatical forms of it — plural for the
 * tab and counts, lowercase for mid-sentence copy, possessive for the bridge
 * dialog. Rather than store every form (a multi-field input UX) or run a full i18n
 * engine, we store the singular and derive the rest here with naive English rules.
 *
 * This is correct for every reasonable container noun — Sprint→Sprints,
 * Iteration→Iterations, PI→PIs, Cycle→Cycles, Increment→Increments. The rare
 * irregular plural is an accepted v1 limitation (ADR-0111: a plural-override field
 * is a clean additive follow-up if a real team needs it).
 *
 * Pure and dependency-free so the mobile app can reuse it verbatim later.
 */

export interface IterationLabelForms {
  /** As stored, e.g. "Iteration" — headings, "{X} Goal", "{X} Backlog". */
  singular: string;
  /** Naive English plural, e.g. "Iterations" — tab label, "No {Xs} yet". */
  plural: string;
  /** Lowercased singular, e.g. "iteration" — mid-sentence "Close {x}". */
  lower: string;
  /** Lowercased plural, e.g. "iterations" — "Last 8 {xs}". */
  lowerPlural: string;
  /** Possessive singular, e.g. "Iteration's" — "the {X's} commitment". */
  possessive: string;
}

/** System default when a project has no (or a blank) stored label. */
export const DEFAULT_ITERATION_LABEL = 'Sprint';

/**
 * Naive English pluralization, sufficient for short container nouns.
 *
 * Rules: `…s/x/z/ch/sh` → `+es`; consonant + `y` → `…ies`; otherwise `+s`.
 * Case of the input is preserved (the suffix matches the trailing case minimally).
 */
function pluralize(singular: string): string {
  if (singular.length === 0) return singular;
  const lower = singular.toLowerCase();
  if (/(s|x|z|ch|sh)$/.test(lower)) return `${singular}es`;
  if (/[^aeiou]y$/.test(lower)) return `${singular.slice(0, -1)}ies`;
  return `${singular}s`;
}

/**
 * Derive every display form from the stored singular label.
 *
 * Trims input and falls back to "Sprint" when blank/absent, so callers never
 * have to guard — `iterationLabelForms(project?.iteration_label)` is safe.
 */
export function iterationLabelForms(stored: string | null | undefined): IterationLabelForms {
  const singular = (stored ?? '').trim() || DEFAULT_ITERATION_LABEL;
  const plural = pluralize(singular);
  return {
    singular,
    plural,
    lower: singular.toLowerCase(),
    lowerPlural: plural.toLowerCase(),
    possessive: `${singular}'s`,
  };
}
