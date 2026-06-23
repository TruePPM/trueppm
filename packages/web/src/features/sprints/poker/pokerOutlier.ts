/**
 * Outlier detection for estimation poker (ADR-0179 §3, #863).
 *
 * The Fibonacci voting ladder. A round is an "outlier" — worth a conversation before
 * committing — when the spread between the highest and lowest numeric vote is at least
 * twice the local step at the median (the gap between the median card and its neighbour).
 * "?" / unsure votes (null) are excluded from the calculation.
 */

export const POKER_CARDS = [1, 2, 3, 5, 8, 13, 21] as const;

/** The local step at a card's position on the ladder — the gap to the next card up (or, for
 * the top card, the gap below). Off-ladder inputs snap to the nearest card first. */
function fibStepAt(value: number): number {
  const card = nearestCard(value);
  const i = POKER_CARDS.indexOf(card as (typeof POKER_CARDS)[number]);
  if (i < POKER_CARDS.length - 1) return POKER_CARDS[i + 1] - POKER_CARDS[i];
  return POKER_CARDS[i] - POKER_CARDS[i - 1];
}

/** The Fibonacci card closest to an arbitrary number (median of an even count may fall
 * between cards). Ties resolve to the lower card. */
function nearestCard(value: number): number {
  let best: number = POKER_CARDS[0];
  let bestDist = Math.abs(value - best);
  for (const c of POKER_CARDS) {
    const d = Math.abs(value - c);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function numericVotes(values: readonly (number | null)[]): number[] {
  return values.filter((v): v is number => typeof v === 'number');
}

/** True when the round's spread is at least twice the local Fibonacci step at the median. */
export function isPokerOutlier(values: readonly (number | null)[]): boolean {
  const nums = numericVotes(values);
  if (nums.length < 2) return false;
  const sorted = [...nums].sort((a, b) => a - b);
  const spread = sorted[sorted.length - 1] - sorted[0];
  return spread >= 2 * fibStepAt(median(sorted));
}

/** The single vote value to surface as the outlier — the one furthest from the median (the
 * max wins ties) — or null when the round is not an outlier. */
export function outlierValue(values: readonly (number | null)[]): number | null {
  if (!isPokerOutlier(values)) return null;
  const nums = numericVotes(values);
  const sorted = [...nums].sort((a, b) => a - b);
  const med = median(sorted);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  // Furthest from the median; ties favor the high card (the over-estimate to discuss).
  return max - med >= med - min ? max : min;
}
