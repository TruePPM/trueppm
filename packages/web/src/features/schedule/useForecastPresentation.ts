import { useMemo } from 'react';
import type { MonteCarloResult } from '@/types';
import { fmtUtcShort, fmtUtcLong } from '@/lib/formatUtcDate';
import { forecastFlatGuidance } from '@/lib/forecastFlatMessage';

/**
 * One derivation of "what does this forecast say", consumed by every surface
 * that renders it (#2426).
 *
 * The bug this exists to make unrepeatable: the Schedule chip row rendered
 * `[P50: Oct 6] [P80: Oct 6 (+11d)] [P95: Oct 6]` — three chips, one date —
 * while the Overview tile said, correctly, "Every simulation finished on
 * October 6, 2026. No date spread to plot." Two surfaces each decided their own
 * state and wrote their own copy, so they contradicted each other about the same
 * run. Now the state and the strings are derived once, here.
 *
 * Three percentile chips on a single-value result imply a distribution the run
 * does not have, so on a degenerate run the percentile keys are **suppressed,
 * not zeroed** — `P80` is a claim about a spread.
 */

export type ForecastState = 'notRun' | 'zeroSpread' | 'spread';

export interface ForecastChip {
  key: string;
  /** Fully composed visible text — the consumer renders it verbatim. */
  text: string;
  /** Tailwind border token. */
  border: string;
  /** Tailwind text-color token. */
  textClass: string;
  /**
   * A dashed chip is a *reference* value (the deterministic CPM finish), not a
   * forecast — the visual distinction matters because it sits in the same row.
   */
  dashed?: boolean;
}

export interface ForecastBaseline {
  /** ISO date of the deterministic CPM finish the delta is measured from. */
  iso: string;
  /** Signed days: positive = the forecast is later than CPM. */
  deltaDays: number;
}

export interface ForecastPresentation {
  state: ForecastState;
  chips: ForecastChip[];
  /** Explanatory prose for a degenerate run; empty otherwise. */
  note: string;
  /** Null when the CPM spine is unknown — in which case no delta is rendered. */
  baseline: ForecastBaseline | null;
}

/** Signed day label ("+11d" / "-4d"). Zero is expressed in words, not "+0d". */
function deltaLabel(days: number): string {
  return days > 0 ? `+${days}d` : `${days}d`;
}

/**
 * The delta clause for the solo chip, always naming the date it is measured from.
 *
 * A bare `+11d` beside `Oct 6` is unreadable: the reader has no way to tell what
 * it is relative to, and the natural (wrong) guess — that it is relative to the
 * neighbouring P50 — makes an identical pair of dates look like a bug.
 */
function baselineClause(baseline: ForecastBaseline | null): string {
  if (!baseline) return '';
  if (baseline.deltaDays === 0) return ' · matches CPM';
  return ` · ${deltaLabel(baseline.deltaDays)} vs CPM (${fmtUtcShort(baseline.iso)})`;
}

/** A forecast ahead of the deterministic spine is good news; tint it accordingly. */
function soloChipTone(baseline: ForecastBaseline | null): { border: string; textClass: string } {
  if (baseline && baseline.deltaDays < 0) {
    return { border: 'border-semantic-on-track/40', textClass: 'text-semantic-on-track' };
  }
  return { border: 'border-semantic-at-risk/40', textClass: 'text-semantic-at-risk' };
}

/**
 * Whether every trial returned the same finish date.
 *
 * ISO date equality across all three percentiles is the strongest signal and the
 * one `MonteCarloHistogram` already uses — matching it keeps the chip row and the
 * histogram from disagreeing about the same run (web-rule 189).
 */
export function isZeroSpread(result: MonteCarloResult): boolean {
  return result.p50 === result.p80 && result.p80 === result.p95;
}

/** Pure derivation — exported so it can be unit-tested without a renderer. */
export function forecastPresentation(
  result: MonteCarloResult | null | undefined,
  cpmFinishFallback?: string | null,
): ForecastPresentation {
  if (!result) {
    return { state: 'notRun', chips: [], note: '', baseline: null };
  }

  // Prefer the server-owned CPM finish on the run payload; fall back to the
  // caller's schedule-derived value (#987). Never synthesize a delta without a
  // baseline date to show beside it.
  const cpmIso = result.cpmFinish ?? cpmFinishFallback ?? null;
  const deltaDays = result.deltaVsCpm?.p80;
  const baseline: ForecastBaseline | null =
    cpmIso && typeof deltaDays === 'number' ? { iso: cpmIso, deltaDays } : null;

  if (isZeroSpread(result)) {
    const tone = soloChipTone(baseline);
    return {
      state: 'zeroSpread',
      chips: [
        {
          key: 'forecast',
          text: `Forecast: ${fmtUtcShort(result.p50)}${baselineClause(baseline)}`,
          ...tone,
        },
      ],
      // Reason-aware guidance (#1340): a flat forecast is not always "no
      // estimates" — it may be estimates pending approval, agile work with no
      // velocity history, or estimated work sitting off the critical path. The
      // server-computed diagnostic carries the real reason, so the note must not
      // hardcode a cause.
      note: `Every simulation finished on ${fmtUtcLong(result.p50)}. No date spread to plot. ${forecastFlatGuidance(result.forecastDiagnostic)}`,
      baseline,
    };
  }

  const chips: ForecastChip[] = [
    {
      key: 'p50',
      text: `P50: ${fmtUtcShort(result.p50)}`,
      border: 'border-semantic-on-track/40',
      textClass: 'text-semantic-on-track',
    },
    {
      key: 'p80',
      // The delta renders once, on the commit chip.
      text: `P80: ${fmtUtcShort(result.p80)}${baseline && baseline.deltaDays !== 0 ? ` (${deltaLabel(baseline.deltaDays)})` : ''}`,
      border: 'border-semantic-at-risk/40',
      textClass: 'text-semantic-at-risk',
    },
    {
      key: 'p95',
      text: `P95: ${fmtUtcShort(result.p95)}`,
      border: 'border-semantic-critical/40',
      textClass: 'text-semantic-critical',
    },
  ];

  // A trailing dashed reference chip, so wherever a delta renders its baseline
  // date is on screen too.
  if (baseline) {
    chips.push({
      key: 'cpm',
      text: `CPM: ${fmtUtcShort(baseline.iso)}`,
      border: 'border-neutral-border',
      textClass: 'text-neutral-text-secondary',
      dashed: true,
    });
  }

  return { state: 'spread', chips, note: '', baseline };
}

/** Hook form — memoized so consumers can pass `presentation.chips` straight to a map. */
export function useForecastPresentation(
  result: MonteCarloResult | null | undefined,
  cpmFinishFallback?: string | null,
): ForecastPresentation {
  return useMemo(
    () => forecastPresentation(result, cpmFinishFallback),
    [result, cpmFinishFallback],
  );
}
