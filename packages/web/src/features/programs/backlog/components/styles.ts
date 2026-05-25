/**
 * Shared className fragments for the program-backlog surfaces. Centralized so
 * the focus ring and button tones stay identical across every interactive
 * element (the design system's 2px brand-primary ring, AA-compliant).
 */

/** Standard keyboard focus ring — matches the app-wide `.focus-visible` style. */
export const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';

/** Shared list grid template (# · ID · Type · Title · Status · Owner · action),
 *  applied to both the column header and every row so they stay aligned. */
export const LIST_GRID = 'grid-cols-[16px_56px_60px_1fr_130px_70px_90px]';

/** Text input / select / textarea base style. */
export const INPUT_BASE =
  'w-full rounded border border-neutral-border bg-neutral-surface px-2 text-xs text-neutral-text-primary ' +
  'placeholder:text-neutral-text-secondary ' +
  FOCUS_RING;

/** Primary (brand-fill) button. */
export const BTN_PRIMARY =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded bg-brand-primary px-3 text-xs font-medium ' +
  'text-white hover:bg-brand-primary-dark disabled:cursor-not-allowed disabled:opacity-50 ' +
  FOCUS_RING;

/** Secondary (outline) button. */
export const BTN_SECONDARY =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded border border-neutral-border ' +
  'bg-neutral-surface px-3 text-xs font-medium text-neutral-text-primary hover:bg-neutral-surface-raised ' +
  'disabled:cursor-not-allowed disabled:opacity-50 ' +
  FOCUS_RING;

/** Ghost (text) button — footer Archive / Restore / Send-back actions. */
export const BTN_GHOST =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded px-2.5 text-xs font-medium ' +
  'text-neutral-text-secondary hover:bg-neutral-surface-sunken hover:text-neutral-text-primary ' +
  'disabled:cursor-not-allowed disabled:opacity-50 ' +
  FOCUS_RING;

/** Destructive ghost — Delete permanently. */
export const BTN_DANGER =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded px-2.5 text-xs font-medium ' +
  'text-semantic-critical hover:bg-semantic-critical-bg disabled:cursor-not-allowed disabled:opacity-50 ' +
  FOCUS_RING;
