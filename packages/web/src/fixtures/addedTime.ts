import type { AddedTimeFacts } from '@/types';

/**
 * The six added-time states, as the server emits them (#2483, #2531).
 *
 * One fixture set, shared by every surface's spec on purpose. The property that
 * matters most about this feature is that the Overview card, the context-bar segment
 * and the mobile forecast card cannot disagree about the same run — and a test proves
 * that only if all three are driven from the *same* facts. Separate per-file fixtures
 * would let two surfaces be tested against two different unestimated projects and
 * still both pass while contradicting each other in production.
 *
 * The dates are internally consistent: a computed finish of Oct 24 with a P80 of
 * Nov 4 is the +11d premium the copy examples use throughout.
 */

const BASE: AddedTimeFacts = {
  risk_premium_state: 'premium',
  risk_premium_days: 11,
  risk_premium_ratio: 0.124,
  risk_premium_band: null,
  risk_premium_as_of: '2026-07-27T09:12:00Z',
  risk_premium_reason: null,
  risk_premium_cpm_finish: '2026-10-24',
  risk_premium_p80: '2026-11-04',
};

export const ADDED_TIME_FIXTURES = {
  /** Estimates exist, the simulation spread, and the P80 lands 11 days out. */
  premium: BASE,

  /** The P80 lands *before* the computed finish — the forecast is good news. */
  negative: {
    ...BASE,
    risk_premium_state: 'negative',
    risk_premium_days: -4,
    risk_premium_ratio: -0.045,
    risk_premium_p80: '2026-10-20',
  },

  /**
   * A real, measured zero: estimates exist and the variance is genuinely low.
   * Numerically identical to `unmeasurable` — which is the entire point of having
   * the server carry a state rather than letting a client read the day count.
   */
  zero: {
    ...BASE,
    risk_premium_state: 'zero',
    risk_premium_days: 0,
    risk_premium_ratio: 0,
    risk_premium_p80: '2026-10-24',
  },

  /**
   * The dangerous one. No task carries a three-point estimate, so every trial
   * returned the same date and the premium is exactly 0 days. The P80 is withheld,
   * because a flat run's "P80" is the computed finish wearing a percentile's name.
   */
  unmeasurable: {
    ...BASE,
    risk_premium_state: 'unmeasurable',
    risk_premium_days: 0,
    risk_premium_ratio: 0,
    risk_premium_reason: 'no_estimates',
    risk_premium_p80: null,
  },

  /** Measured, but against a schedule that has had over a week to move underneath it. */
  stale: { ...BASE, risk_premium_state: 'stale', risk_premium_as_of: '2026-07-14T09:12:00Z' },

  /** No simulation has ever been run for this project. */
  notRun: {
    risk_premium_state: 'not_run',
    risk_premium_days: null,
    risk_premium_ratio: null,
    risk_premium_band: null,
    risk_premium_as_of: null,
    risk_premium_reason: null,
    risk_premium_cpm_finish: null,
    risk_premium_p80: null,
  },
} as const satisfies Record<string, AddedTimeFacts>;

/** The six state keys, for `it.each` sweeps that must cover every one of them. */
export const ADDED_TIME_STATES = Object.keys(ADDED_TIME_FIXTURES) as (keyof typeof ADDED_TIME_FIXTURES)[];
