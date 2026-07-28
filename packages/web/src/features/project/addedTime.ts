import type { ForecastReason } from '@/types';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { forecastRemedyForReason } from '@/lib/forecastFlatMessage';

/**
 * "Added time" — one derivation of what the schedule risk premium says (#2483).
 *
 * The premium is the gap between the computed (CPM) finish and the P80 commitment
 * date: the time schedule uncertainty adds on top of the plan. This module turns the
 * server's facts into the single presentation every surface renders, so the Overview
 * card, the strip segment, the forecast panel and the mobile card cannot disagree
 * about the same run — the discipline #2426 introduced, extended to the premium.
 *
 * The structure is load-bearing, not stylistic. `AddedTimePresentation` is a
 * discriminated union, and the measured presentation (a digit, a proportion track, an
 * as-of stamp) exists *only* on the variants entitled to it. A renderer therefore
 * cannot reach a presentation its state does not carry, which is what keeps a
 * project with no estimates from rendering as a project with no risk — see
 * {@link AddedTimeUnmeasurable}.
 */

/** The two dates the gap is measured between. Never shed — a delta without its
 *  baseline on screen is unverifiable (#2426), so every variant carries what it can. */
export interface AddedTimeEndpoints {
  /** ISO date of the deterministic CPM finish. */
  cpmFinish: string;
  /** ISO date of the P80 commitment, or null when there is no forecast to compare. */
  p80: string | null;
}

/** A real, measured premium: estimates existed, the simulation produced a spread. */
export interface AddedTimeMeasured {
  state: 'premium' | 'zero' | 'negative' | 'stale';
  endpoints: AddedTimeEndpoints;
  /** Headline text. Words, never `+0d` — a zero premium is stated, not printed. */
  headline: string;
  /** Share of remaining duration, 0–100, for the proportion track. Null when the
   *  computed finish is already in the past and there is no remainder to divide by. */
  ratioPct: number | null;
  ratioLabel: string | null;
  /** ISO timestamp of the run this came from. */
  asOf: string;
  /** Server verdict, or null while the band waits on calibrated thresholds (#2299). */
  band: string | null;
}

/**
 * The simulation had nothing to measure — most often because no task carries a
 * three-point estimate.
 *
 * This is the variant the whole feature is arranged around. Such a project simulates
 * flat, so its premium is exactly 0 days, numerically identical to a well-estimated
 * project with genuinely low variance. Printing that 0 would tell the least-known
 * project in the portfolio that it carries no schedule risk. So this variant has no
 * `headline` number, no `ratioPct`, no `asOf` and no P80 at all: the measured
 * presentation is not merely unused here, it is unreachable.
 */
export interface AddedTimeUnmeasurable {
  state: 'unmeasurable';
  endpoints: AddedTimeEndpoints;
  /** Why there is no result, and what to do about it. */
  reason: string;
}

/** No simulation has ever been run for this project. */
export interface AddedTimeNotRun {
  state: 'notRun';
  endpoints: AddedTimeEndpoints | null;
  reason: string;
}

export type AddedTimePresentation = AddedTimeMeasured | AddedTimeUnmeasurable | AddedTimeNotRun;

/** The `risk_premium_*` slice of the project overview payload. */
export interface AddedTimeFacts {
  risk_premium_state?: 'not_run' | 'unmeasurable' | 'stale' | 'zero' | 'premium' | 'negative';
  risk_premium_days?: number | null;
  risk_premium_ratio?: number | null;
  risk_premium_band?: string | null;
  risk_premium_as_of?: string | null;
  risk_premium_reason?: ForecastReason | null;
  risk_premium_cpm_finish?: string | null;
  risk_premium_p80?: string | null;
}

/** The term the user learns, used as the card title, the panel heading and the help. */
export const ADDED_TIME_LABEL = 'Added time';
export const ADDED_TIME_LABEL_QUALIFIED = 'Added time vs computed finish';

/**
 * The sentence this whole feature's safety rests on.
 *
 * It has to do two things in the order given: refuse the reassuring reading first,
 * *then* name the fix. Leading with the remedy ("add estimates to see a forecast")
 * lets a hurried reader take the blank as "nothing to worry about yet".
 */
const NO_RESULT_PREFIX = 'This is not a low-risk result — it is no result.';

const NOT_RUN_REASON = 'This project has estimates but no forecast has been run.';

/** Signed day label. Zero never reaches this — it is expressed in words (#2426). */
function deltaLabel(days: number): string {
  return days > 0 ? `+${days}d` : `−${Math.abs(days)}d`;
}

function endpointsOf(facts: AddedTimeFacts): AddedTimeEndpoints | null {
  const cpmFinish = facts.risk_premium_cpm_finish;
  if (!cpmFinish) return null;
  return { cpmFinish, p80: facts.risk_premium_p80 ?? null };
}

/**
 * Derive the one presentation for a project's added time.
 *
 * The server owns the state (`risk_premium_state`) so that no client re-decides what
 * a premium of `0` means; this function maps that state to copy and never
 * re-classifies. A payload with no state at all — an API older than #2483 — is
 * treated as `notRun` rather than guessed at.
 */
export function addedTimePresentation(facts: AddedTimeFacts | undefined): AddedTimePresentation {
  const endpoints = facts ? endpointsOf(facts) : null;
  const state = facts?.risk_premium_state;

  if (!facts || !state || state === 'not_run' || endpoints === null) {
    return { state: 'notRun', endpoints, reason: NOT_RUN_REASON };
  }

  if (state === 'unmeasurable') {
    return {
      state: 'unmeasurable',
      endpoints,
      reason: `${NO_RESULT_PREFIX} ${forecastRemedyForReason(facts.risk_premium_reason ?? null)}`,
    };
  }

  const days = facts.risk_premium_days ?? 0;
  const ratio = facts.risk_premium_ratio;
  const ratioPct = ratio == null ? null : Math.round(ratio * 100);

  return {
    state,
    endpoints,
    headline: days === 0 ? 'No added time' : deltaLabel(days),
    ratioPct,
    ratioLabel: ratioPct == null ? null : `${ratioPct}% of remaining duration`,
    asOf: facts.risk_premium_as_of ?? '',
    // A verdict cannot be stale and still be a verdict: an old band describes a
    // schedule that has had a week to move, so staleness suppresses it rather than
    // presenting it as current.
    band: state === 'stale' ? null : (facts.risk_premium_band ?? null),
  };
}

/**
 * Format one endpoint of the gap, adding a year only when it crosses out of the
 * baseline's year.
 *
 * `fmtUtcShort` renders "Jan 20" with no year, which is fine for two dates weeks
 * apart and actively wrong here: a severe premium can push the P80 into the *next*
 * year, and "Oct 24 → Jan 20" reads as eleven weeks early rather than fourteen
 * months late. The crossed year boundary is one of the two ways this card conveys
 * magnitude without spending a health colour, so it has to be visible.
 */
export function formatEndpoint(iso: string, baselineIso: string): string {
  const short = fmtUtcShort(iso);
  const year = new Date(iso).getUTCFullYear();
  if (year === new Date(baselineIso).getUTCFullYear()) return short;
  return `${short} ’${String(year).slice(-2)}`;
}

/**
 * Spoken form of the headline, for the states that print a signed day count.
 *
 * `−11d` is read as "dash eleven d" by some screen readers, which loses the sign that
 * carries the entire meaning — the difference between the forecast running late and
 * running early. Everything else on the card (both dates, the ratio, the as-of stamp)
 * is a `<dl>` and reads correctly on its own, so this is the only value that needs a
 * spoken alternative rather than a wholesale composite label.
 */
export function addedTimeSpokenHeadline(headline: string): string {
  if (!headline.startsWith('+') && !headline.startsWith('−')) return headline;
  const days = headline.replace(/[+−d]/g, '');
  const unit = days === '1' ? 'day' : 'days';
  return headline.startsWith('+')
    ? `${days} ${unit} added`
    : `${days} ${unit} earlier than the computed finish`;
}
