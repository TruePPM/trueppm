/**
 * Scoring-inputs section of the story-detail drawer (#1043). Surfaces the active
 * prioritization model's raw inputs in plain English with a live, client-side
 * score preview that mirrors the server `compute_score` exactly. Before this, the
 * inputs were not editable anywhere in the web UI, so Auto-rank produced "—" for
 * every story (#922 shipped invisibly on a fresh project).
 *
 * Omitted entirely when the project has no model (`none`) — never a disabled stub,
 * matching how the page hides the score column. Read-only for callers without
 * backlog-manage rights (structural fields are Admin+/PO-gated server-side).
 */

import type { PrioritizationModel } from '@/types';
import { previewScore, SCORING_FIELDS, type ScoringInputValues } from '../scorePreview';

interface ScoringInputsProps {
  model: PrioritizationModel;
  values: ScoringInputValues;
  onChange: (key: keyof ScoringInputValues, value: number | null) => void;
  readOnly: boolean;
}

export function ScoringInputs({ model, values, onChange, readOnly }: ScoringInputsProps) {
  if (model === 'none') return null;
  const config = SCORING_FIELDS[model];
  const score = previewScore(model, values);

  return (
    <section aria-labelledby="drawer-scoring-heading" className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3
          id="drawer-scoring-heading"
          className="text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary"
        >
          Scoring · {model === 'value_effort' ? 'Value / Effort' : model.toUpperCase()}
        </h3>
        <span className="tppm-mono text-sm font-bold text-neutral-text-primary">
          {score == null ? (
            <span className="text-neutral-text-secondary">—</span>
          ) : (
            score.toFixed(1)
          )}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {config.fields.map(({ key, label, step }) => (
          <label key={key} className="flex flex-col gap-1">
            <span className="text-xs font-medium text-neutral-text-secondary">{label}</span>
            {readOnly ? (
              <span className="tppm-mono px-2 py-1.5 text-sm text-neutral-text-primary">
                {values[key] ?? '—'}
              </span>
            ) : (
              <input
                type="number"
                inputMode="decimal"
                step={step ?? 1}
                min={0}
                value={values[key] ?? ''}
                onChange={(e) =>
                  onChange(key, e.target.value === '' ? null : Number(e.target.value))
                }
                aria-label={label}
                className="tppm-mono h-9 rounded-control border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              />
            )}
          </label>
        ))}
      </div>

      <p className="tppm-mono text-xs text-neutral-text-secondary">{config.formula(values)}</p>
      {readOnly && (
        <p className="text-xs italic text-neutral-text-secondary">
          Scoring is managed by the Product Owner.
        </p>
      )}
    </section>
  );
}
