/**
 * Shared className fragments for the program-backlog surfaces. Centralized so
 * the focus ring and button tones stay identical across every interactive
 * element (the design system's 2px brand-primary ring, AA-compliant).
 */

/**
 * Standard keyboard focus ring for standalone interactive controls (buttons,
 * radios, list rows). Uses `focus:` — NOT `focus-visible:` — because
 * `focus-visible:` withholds the ring on pointer-driven focus in Firefox and
 * desktop Safari (web-rule 214). The export name is kept as `FOCUS_RING` (only
 * the value changed) because other modules import it by this name.
 */
export const FOCUS_RING =
  'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1';

/**
 * Focus ring for a bordered field WRAPPER that contains an `<input>` (or for a
 * bare input/select/textarea). `focus-within:` so the ring surfaces when the
 * inner control is focused, per web-rule 157 (a wrapper's `focus-visible:`
 * never fires on a descendant's focus, leaving the field with no indicator).
 */
export const FOCUS_RING_INPUT =
  'focus-within:outline-none focus-within:ring-2 focus-within:ring-brand-primary focus-within:ring-offset-1';

/** Shared list grid template (# · Type · Title · Status · action), applied to
 *  both the column header and every row so they stay aligned. (The API has no
 *  assignee, so there is no Owner column; ids are UUIDs, not shown in the dense
 *  list.) */
export const LIST_GRID = 'grid-cols-[20px_60px_1fr_140px_84px]';

/** Text input / select / textarea base style. */
export const INPUT_BASE =
  'w-full rounded-control border border-neutral-border bg-neutral-surface px-2 text-xs text-neutral-text-primary ' +
  'placeholder:text-neutral-text-secondary ' +
  FOCUS_RING_INPUT;

/** Primary (brand-fill) button. */
export const BTN_PRIMARY =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-control bg-brand-primary px-3 text-xs font-medium ' +
  'text-white hover:bg-brand-primary-dark disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed ' +
  FOCUS_RING;

/** Secondary (outline) button. */
export const BTN_SECONDARY =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-control border border-neutral-border ' +
  'bg-neutral-surface px-3 text-xs font-medium text-neutral-text-primary hover:bg-neutral-surface-raised ' +
  'disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed ' +
  FOCUS_RING;

/** Ghost (text) button — footer Archive / Restore / Send-back actions. */
export const BTN_GHOST =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-control px-2.5 text-xs font-medium ' +
  'text-neutral-text-secondary hover:bg-neutral-surface-sunken hover:text-neutral-text-primary ' +
  'disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed ' +
  FOCUS_RING;

/** Destructive ghost — Delete permanently. */
export const BTN_DANGER =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-control px-2.5 text-xs font-medium ' +
  'text-semantic-critical hover:bg-semantic-critical-bg disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed ' +
  FOCUS_RING;
