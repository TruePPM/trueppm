/**
 * Formatting for Monte Carlo forecast-drift deltas (ADR-0109, issue 961).
 *
 * A delta is the change in a percentile finish date versus the immediately
 * previous (older) run, in days. Positive = the forecast slipped later (worse);
 * negative = it was pulled earlier (better). The formatted result carries four
 * redundant channels — glyph, sign, tone, and an aria phrase — so meaning never
 * depends on color alone (WCAG).
 */

export type DeltaTone = 'slip' | 'earlier' | 'neutral';

export interface FormattedDelta {
  /** e.g. "+14d", "−5d", "0d". Uses a true minus sign (−) for negatives. */
  text: string;
  /** Directional glyph: ▲ later, ▼ earlier, ◆ unchanged. */
  glyph: string;
  tone: DeltaTone;
  /** Screen-reader phrase, e.g. "slipped 14 days later". */
  aria: string;
}

/**
 * Format a day delta for display. Returns `null` when there is no delta to show
 * (the oldest/baseline run, or a percentile missing from either run).
 */
export function formatDelta(days: number | null | undefined): FormattedDelta | null {
  if (days === null || days === undefined) {
    return null;
  }
  if (days === 0) {
    return { text: '0d', glyph: '◆', tone: 'neutral', aria: 'unchanged' };
  }
  const magnitude = Math.abs(days);
  if (days > 0) {
    return {
      text: `+${magnitude}d`,
      glyph: '▲',
      tone: 'slip',
      aria: `slipped ${magnitude} ${magnitude === 1 ? 'day' : 'days'} later`,
    };
  }
  return {
    text: `−${magnitude}d`,
    glyph: '▼',
    tone: 'earlier',
    aria: `pulled ${magnitude} ${magnitude === 1 ? 'day' : 'days'} earlier`,
  };
}

/** Tailwind text-color token for a delta tone (brand v2 navy/sage). */
export function deltaToneClass(tone: DeltaTone): string {
  switch (tone) {
    case 'slip':
      return 'text-semantic-at-risk';
    case 'earlier':
      return 'text-semantic-on-track';
    case 'neutral':
      return 'text-neutral-text-secondary';
  }
}

/**
 * Format an ISO date string as e.g. "Aug 28, 2026", or "—" when null.
 *
 * Pinned to `timeZone: 'UTC'`: the server's forecast dates are UTC calendar
 * dates with no offset, so a local-zone format drifts a day west of UTC
 * (ADR-0144 — the same root cause `lib/formatUtcDate` fixes elsewhere).
 */
export function fmtForecastDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
