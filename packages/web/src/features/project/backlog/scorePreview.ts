/**
 * Client-side mirror of the server's `compute_score`
 * (apps/projects/product_backlog_services.py) for the grooming drawer's live
 * score preview (#1043). It MUST match the server exactly: same formulas, and
 * `null` (rendered as "—") whenever any required input is missing OR the
 * denominator is falsy (null/0). A 0 job-size/effort yields `null`, never
 * Infinity — that is the trap a naive `=== null` denominator check would miss,
 * so the denominator guard is `!denom` (falsy), matching Python's `not size`.
 *
 * The previewed value is advisory only; the authoritative score arrives from the
 * server on the next backlog refetch after Save.
 */

import type { PrioritizationModel } from '@/types';

export interface ScoringInputValues {
  businessValue?: number | null;
  timeCriticality?: number | null;
  riskReduction?: number | null;
  jobSize?: number | null;
  reach?: number | null;
  impact?: number | null;
  confidence?: number | null;
  effort?: number | null;
  value?: number | null;
  effortEstimate?: number | null;
}

export function previewScore(model: PrioritizationModel, v: ScoringInputValues): number | null {
  switch (model) {
    case 'wsjf': {
      const { businessValue: bv, timeCriticality: tc, riskReduction: rr, jobSize } = v;
      if (bv == null || tc == null || rr == null || !jobSize) return null;
      return (bv + tc + rr) / jobSize;
    }
    case 'rice': {
      const { reach, impact, confidence, effort } = v;
      if (reach == null || impact == null || confidence == null || !effort) return null;
      return (reach * impact * confidence) / effort;
    }
    case 'value_effort': {
      const { value, effortEstimate } = v;
      if (value == null || !effortEstimate) return null;
      return value / effortEstimate;
    }
    default:
      return null;
  }
}

/** Which input fields the active model uses, in display order, with plain-English labels. */
export interface ScoringField {
  key: keyof ScoringInputValues;
  label: string;
  /** RICE multipliers / efforts allow decimals; WSJF + value are small integers. */
  step?: number;
}

export const SCORING_FIELDS: Record<
  Exclude<PrioritizationModel, 'none'>,
  { fields: ScoringField[]; formula: (v: ScoringInputValues) => string }
> = {
  wsjf: {
    fields: [
      { key: 'businessValue', label: 'Business value' },
      { key: 'timeCriticality', label: 'Time criticality' },
      { key: 'riskReduction', label: 'Risk reduction' },
      { key: 'jobSize', label: 'Job size' },
    ],
    formula: (v) =>
      `WSJF = (${num(v.businessValue)} + ${num(v.timeCriticality)} + ${num(v.riskReduction)}) ÷ ${num(v.jobSize)}`,
  },
  rice: {
    fields: [
      { key: 'reach', label: 'Reach' },
      { key: 'impact', label: 'Impact', step: 0.25 },
      { key: 'confidence', label: 'Confidence', step: 0.25 },
      { key: 'effort', label: 'Effort', step: 0.5 },
    ],
    formula: (v) =>
      `RICE = (${num(v.reach)} × ${num(v.impact)} × ${num(v.confidence)}) ÷ ${num(v.effort)}`,
  },
  value_effort: {
    fields: [
      { key: 'value', label: 'Value' },
      { key: 'effortEstimate', label: 'Effort', step: 0.5 },
    ],
    formula: (v) => `Value ÷ Effort = ${num(v.value)} ÷ ${num(v.effortEstimate)}`,
  },
};

function num(n: number | null | undefined): string {
  return n == null ? '—' : String(n);
}
