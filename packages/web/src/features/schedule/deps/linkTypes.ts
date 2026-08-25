import type { LinkType } from '@/types';

/**
 * The dependency-link vocabulary — **one** owner for the four types, their
 * order, and what each is called (#3023 step 3).
 *
 * ## Why this module exists
 *
 * The four types were declared in three places before this: the `⌥→` cycle in
 * `buildMode/authoringTokens.ts`, the flag's canonical sort in `depFlag.ts`,
 * and the drawer's `<select>` options in `DependenciesTab.tsx`. All three
 * happened to agree on `FS SS FF SF`, and each documented itself as the reason
 * the order could not drift — which is three files each believing it is the
 * single source.
 *
 * Order is not cosmetic. `depFlag` sorts by it so a row whose links arrived
 * FS-then-SS reads the same as one whose links arrived SS-then-FS; without a
 * shared order, two identical schedule shapes get two different flags and the
 * column stops being comparable. `cycleDependencyType` steps through it, and
 * the keyboard cheatsheet renders it. A fourth copy was about to be added by
 * the picker, which is what prompted this.
 *
 * ## Two label sets, on purpose
 *
 * The drawer's `<select>` said "Finish → Start" while the flag's tooltip said
 * "Finish-to-Start". That looks like drift and is **not**: an arrow reads well
 * in a narrow control and badly inside a sentence, and the tooltip's job is to
 * spell the token out in prose. So both survive, named for the context that
 * wants them rather than left as two anonymous maps that a future consolidation
 * would "fix" by picking one and making the other surface read worse.
 *
 * What is *not* permitted is a third label set, or either of these being
 * rewritten locally at a call site.
 */

/**
 * The four types in canonical order, and the order `⌥→` cycles through.
 *
 * `as const` so the tuple's literal members are the type below rather than
 * `string[]` — a widened array would let an unrecognized token flow into the
 * flag's sort and out to the user.
 */
export const LINK_TYPES = ['FS', 'SS', 'FF', 'SF'] as const;

/** Every link type, derived from the tuple rather than restated beside it. */
export type CanonicalLinkType = (typeof LINK_TYPES)[number];

/**
 * Compact label for a **control** — a `<select>` option, a chip, a stepper.
 * The arrow carries the direction in the width a control can spare.
 */
export const LINK_TYPE_CONTROL_LABEL: Record<CanonicalLinkType, string> = {
  FS: 'Finish → Start',
  SS: 'Start → Start',
  FF: 'Finish → Finish',
  SF: 'Start → Finish',
};

/**
 * Spelled-out name for **prose** — a tooltip, an announcement, a sentence.
 * "Finish-to-Start" reads aloud; "Finish → Start" does not.
 */
export const LINK_TYPE_PROSE_NAME: Record<CanonicalLinkType, string> = {
  FS: 'Finish-to-Start',
  SS: 'Start-to-Start',
  FF: 'Finish-to-Finish',
  SF: 'Start-to-Finish',
};

/** The drawer's `<select>` shape, so both surfaces build options identically. */
export const LINK_TYPE_OPTIONS: readonly { value: CanonicalLinkType; label: string }[] =
  LINK_TYPES.map((value) => ({ value, label: LINK_TYPE_CONTROL_LABEL[value] }));

/**
 * Lag bounds, shared by every surface that edits one.
 *
 * ±365 days is the drawer's shipped range. Stated here so the picker cannot
 * accept a value the drawer would refuse — a link created out of range would
 * be uneditable on the surface that owns editing.
 */
export const LAG_MIN_DAYS = -365;
export const LAG_MAX_DAYS = 365;

/**
 * What a lag control is called, and the one place the lead/lag convention is
 * explained. Negative is a **lead** — the successor may start before the
 * predecessor's constraint — and that is not guessable from the field.
 */
export const LAG_FIELD_LABEL = 'Lag days';
export const LAG_FIELD_HINT = 'Lag in days (negative = lead)';
/** Unit suffix rendered beside the field. */
export const LAG_UNIT_SUFFIX = 'd lag';

/**
 * Accessible name for a link-type control, optionally naming the link it acts
 * on.
 *
 * **Not one shared constant, and the reason matters.** The first attempt at
 * #2916 gave `DepRow` and `AddDepRow` the same string, on the theory that two
 * names for one control is drift. It is the opposite: they are two *different*
 * controls, and an identical name makes them indistinguishable — to a test, and
 * to the screen-reader user the name exists for.
 *
 * It also surfaced a defect that predates both: a task with three predecessors
 * renders three selects all called "Dependency type" and three inputs all
 * called "Lag days", so navigating by form control gives no way to tell which
 * link is which. Passing the row's label fixes that.
 *
 * The argument is **required**, not optional. An add-row has no existing link
 * to name, but it does have a side — "new predecessor" / "new successor" — and
 * the drawer renders one add-row per section, so a bare fallback would leave
 * those two identical to each other. An optional parameter is exactly what the
 * next caller omits (web rule 325).
 */
export function linkTypeFieldLabel(target: string): string {
  return `Dependency type for ${target}`;
}

/** The same, for a lag control. Same reasoning, same shape. */
export function lagFieldLabelFor(target: string): string {
  return `${LAG_FIELD_LABEL} for ${target}`;
}

/**
 * Resolve a lag field's raw text to the number that goes on the wire.
 *
 * Every lag control holds TEXT, not a number, because a number state has to
 * decide what the emptied field means and every answer is wrong: `0` silently
 * rewrites what the user cleared, `NaN` reaches the payload, `null` needs a
 * branch at every read. Deferring it means exactly one place has to answer, and
 * this is it — `""` and a lone `"-"` (mid-typing a lead) both resolve to 0.
 *
 * Clamped to the bounds every surface shares, so no creation path can mint a
 * link that the drawer, which owns editing, would refuse to accept.
 *
 * Extracted from the picker in #2916 rather than copied into the drawer: two
 * parsers for one field is how the two surfaces come to disagree about what an
 * empty box means.
 */
export function clampLagDays(text: string): number {
  const n = Number.parseInt(text, 10);
  if (Number.isNaN(n)) return 0;
  return Math.min(LAG_MAX_DAYS, Math.max(LAG_MIN_DAYS, n));
}

/** Is this string one of the four? Narrows an unknown server token. */
export function isCanonicalLinkType(value: string): value is CanonicalLinkType {
  return (LINK_TYPES as readonly string[]).includes(value);
}

/**
 * Advance a type one step around the cycle, wrapping at either end.
 *
 * `% len` twice so a negative `steps` (`⌥←`) wraps forward rather than
 * indexing out of the tuple.
 */
export function cycleLinkType(current: CanonicalLinkType, steps = 1): CanonicalLinkType {
  const i = LINK_TYPES.indexOf(current);
  const len = LINK_TYPES.length;
  return LINK_TYPES[(((i + steps) % len) + len) % len];
}

/** Compile-time proof that the canonical tuple and the app's `LinkType` agree. */
const _canonicalMatchesLinkType: CanonicalLinkType extends LinkType ? true : never = true;
void _canonicalMatchesLinkType;
