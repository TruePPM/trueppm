/**
 * Estimation-scale value lists, T-shirt label↔integer map, and point formatting
 * (ADR-0510, #2027). Single source of truth for every story-point picker and badge.
 *
 * `story_points` is always stored as a plain integer (ADR-0418) — the scale is a
 * *display + input projection* over that integer, never a second stored value. A
 * T-shirt "M" is the integer `3` wearing a label, so velocity/rollup math (which
 * sums integers) is untouched and a project can switch scales without a data
 * migration. Off-scale integers (a `13` left after a Fibonacci→Linear switch, an
 * MSP-imported `7`) always still render as their raw number — never blank, never
 * coerced.
 *
 * Aggregates (sprint velocity, Epic rollup totals, burndown axes) render the raw
 * integer + " pts" on EVERY scale — you cannot average T-shirt labels. Use
 * {@link formatStoryPoints} for a *single item's* estimate only.
 */
import type { EstimationScale } from '@/api/types';

/** Ordered T-shirt sizes and the integers they map to (kept in size order). */
const TSHIRT_MAP: ReadonlyArray<{ label: string; value: number }> = [
  { label: 'XS', value: 1 },
  { label: 'S', value: 2 },
  { label: 'M', value: 3 },
  { label: 'L', value: 5 },
  { label: 'XL', value: 8 },
];

const FIBONACCI = [1, 2, 3, 5, 8, 13, 21];
const LINEAR = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** A selectable point option: the stored integer plus its scale-specific label. */
export interface PointOption {
  /** The integer stored in `story_points`. */
  value: number;
  /** What the user sees (a number, or a T-shirt size). */
  label: string;
  /** True when this value is not part of the active scale (a preserved legacy value). */
  offScale: boolean;
}

/** The ordered, on-scale selectable entries for a scale (no empty/off-scale rows). */
export function scalePoints(scale: EstimationScale): ReadonlyArray<{ value: number; label: string }> {
  if (scale === 'tshirt') return TSHIRT_MAP;
  const nums = scale === 'linear' ? LINEAR : FIBONACCI;
  return nums.map((n) => ({ value: n, label: String(n) }));
}

/** The T-shirt label for a stored integer, or null if it is not a T-shirt value. */
function tshirtLabel(value: number): string | null {
  return TSHIRT_MAP.find((t) => t.value === value)?.label ?? null;
}

/**
 * Single-item display for a stored estimate under a scale.
 *
 * - T-shirt on-scale → the size label ("M").
 * - Fibonacci/Linear (or a T-shirt off-scale value) → the raw number.
 * - Off-scale under any scale → the raw number (never blank).
 * - `null` → "" (callers hide the badge entirely for the empty state).
 *
 * NEVER use for aggregates — an averaged T-shirt size is meaningless.
 */
export function formatStoryPoints(value: number | null, scale: EstimationScale): string {
  if (value === null) return '';
  if (scale === 'tshirt') {
    const label = tshirtLabel(value);
    if (label !== null) return label;
  }
  return String(value);
}

/**
 * Badge suffix for a single-item estimate: "" for T-shirt (the size stands alone),
 * " pts" otherwise. An off-scale value under T-shirt renders as a number, so it
 * takes the " pts" suffix too.
 */
export function storyPointsUnit(value: number | null, scale: EstimationScale): '' | ' pts' {
  if (scale === 'tshirt' && value !== null && tshirtLabel(value) !== null) return '';
  return ' pts';
}

/**
 * "Is this item large?" — replaces the hardcoded `>= 8` threshold that was
 * duplicated in the mobile grooming card. Fibonacci/Linear: `>= 8`; T-shirt:
 * `>= 5` (L, XL). Off-scale values fall through to the numeric threshold.
 */
export function isOversizedForScale(value: number | null, scale: EstimationScale): boolean {
  if (value === null) return false;
  if (scale === 'tshirt') return value >= 5;
  return value >= 8;
}

/**
 * Option model for a story-point `<select>` input, including the leading empty
 * row and — when the current value is off the active scale — a trailing,
 * preserved off-scale entry so a scale switch is never destructive.
 */
export function pointInputOptions(
  scale: EstimationScale,
  currentValue: number | null,
): PointOption[] {
  const onScale = scalePoints(scale).map((o) => ({ ...o, offScale: false }));
  if (currentValue !== null && !onScale.some((o) => o.value === currentValue)) {
    onScale.push({ value: currentValue, label: `(${currentValue})`, offScale: true });
  }
  return onScale;
}
