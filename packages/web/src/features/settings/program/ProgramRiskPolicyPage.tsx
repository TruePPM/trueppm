import { useState } from 'react';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';

type Threshold = 'low' | 'medium' | 'high' | 'critical';

const THRESHOLD_LABELS: Record<Threshold, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

const THRESHOLD_STYLE: Record<Threshold, string> = {
  low:      'bg-neutral-surface-sunken text-neutral-text-secondary border-neutral-border',
  medium:   'bg-brand-accent-light text-brand-accent-dark border-brand-accent/40',
  high:     'bg-brand-accent-light text-brand-accent-dark border-brand-accent/40',
  critical: 'bg-semantic-critical/10 text-semantic-critical border-semantic-critical/40',
};

/** 5×5 risk matrix cell. */
function MatrixCell({ probability, impact }: { probability: number; impact: number }) {
  const score = probability * impact;
  const threshold: Threshold =
    score >= 20 ? 'critical' :
    score >= 12 ? 'high' :
    score >= 6  ? 'medium' : 'low';

  return (
    <div
      className={`flex items-center justify-center rounded text-[10px] font-bold tppm-mono border ${THRESHOLD_STYLE[threshold]}`}
      style={{ height: 36 }}
      title={`P${probability} × I${impact} = ${score} (${THRESHOLD_LABELS[threshold]})`}
      aria-label={`Probability ${probability}, Impact ${impact}, score ${score}, ${THRESHOLD_LABELS[threshold]}`}
    >
      {score}
    </div>
  );
}

/** Program > Risk & dependencies policy settings page. */
export function ProgramRiskPolicyPage() {
  const [slipPropagation, setSlipPropagation] = useState<'none' | 'warn' | 'block'>('warn');
  const [escalationDays, setEscalationDays] = useState(3);

  return (
    <div>
      <SettingsPageTitle
        title="Risk & deps policy"
        subtitle="Risk matrix thresholds, cross-project dependency slip propagation rules, and escalation paths."
      />

      <div className="px-6 pb-8 max-w-[720px] space-y-6">
        {/* 5×5 matrix */}
        <section aria-labelledby="matrix-heading">
          <h2 id="matrix-heading" className="text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary mb-3">
            Risk matrix (read-only — thresholds are org-wide)
          </h2>
          <div className="bg-neutral-surface-raised border border-neutral-border rounded-lg p-4 overflow-x-auto">
            <div className="grid gap-1" style={{ gridTemplateColumns: 'auto repeat(5, 1fr)', minWidth: 320 }}>
              {/* Corner */}
              <div />
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="text-center text-[10px] font-semibold text-neutral-text-secondary pb-1">
                  I{i}
                </div>
              ))}
              {[5, 4, 3, 2, 1].map((p) => (
                <>
                  <div key={`label-${p}`} className="text-[10px] font-semibold text-neutral-text-secondary flex items-center pr-2">
                    P{p}
                  </div>
                  {[1, 2, 3, 4, 5].map((impact) => (
                    <MatrixCell key={impact} probability={p} impact={impact} />
                  ))}
                </>
              ))}
            </div>
            {/* Legend */}
            <div className="flex items-center gap-3 mt-3 pt-3 border-t border-neutral-border/55">
              {(['low', 'medium', 'high', 'critical'] as Threshold[]).map((t) => (
                <span key={t} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-semibold ${THRESHOLD_STYLE[t]}`}>
                  {THRESHOLD_LABELS[t]}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* Slip propagation */}
        <section aria-labelledby="slip-heading" className="bg-neutral-surface-raised border border-neutral-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-border/55">
            <h2 id="slip-heading" className="text-[13px] font-semibold text-neutral-text-primary">Cross-project dependency slip</h2>
            <p className="text-[12px] text-neutral-text-secondary mt-0.5">
              What happens when a predecessor task in one project slips and blocks a successor in another.
            </p>
          </div>
          <div className="px-4 py-3 space-y-2">
            {(
              [
                { id: 'none'  as const, label: 'No action',    hint: 'Slip is visible in the schedule but no notification or gate fires.' },
                { id: 'warn'  as const, label: 'Warn only',    hint: 'Notify the successor PM and the program manager via in-app alert.' },
                { id: 'block' as const, label: 'Block & escalate', hint: 'Lock the successor task from starting and open an escalation ticket.' },
              ]
            ).map((opt) => (
              <label key={opt.id} className="flex items-start gap-2.5 cursor-pointer rounded p-2 hover:bg-neutral-surface-sunken">
                <span
                  className={[
                    'mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center',
                    slipPropagation === opt.id ? 'border-brand-primary bg-brand-primary' : 'border-neutral-border bg-neutral-surface',
                  ].join(' ')}
                  aria-hidden="true"
                >
                  {slipPropagation === opt.id && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                </span>
                <input
                  type="radio"
                  name="slip-policy"
                  value={opt.id}
                  checked={slipPropagation === opt.id}
                  onChange={() => setSlipPropagation(opt.id)}
                  className="sr-only"
                />
                <span className="flex flex-col">
                  <span className="text-[13px] font-medium text-neutral-text-primary">{opt.label}</span>
                  <span className="text-[12px] text-neutral-text-secondary">{opt.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </section>

        {/* Escalation */}
        <FieldRow label="Auto-escalate after" hint="Days a blocked dependency can sit without resolution before escalating to the program manager.">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={30}
              value={escalationDays}
              onChange={(e) => setEscalationDays(Number(e.target.value))}
              className="w-20 h-8 px-2.5 rounded border border-neutral-border bg-neutral-surface-raised tppm-mono text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            />
            <span className="text-[13px] text-neutral-text-secondary">days</span>
          </div>
        </FieldRow>
      </div>
    </div>
  );
}
