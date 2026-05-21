import { useState } from 'react';
import { SettingsPageTitle } from '../SettingsShell';
import { StubFieldset } from '../components/StubFieldset';
import { StubPageBanner } from '../components/StubPageBanner';

interface KpiToggle {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
}

const DEFAULT_KPIS: KpiToggle[] = [
  { id: 'schedule-health',    label: 'Schedule health',         description: 'Rollup of project health dots weighted by task count.',          enabled: true  },
  { id: 'critical-tasks',     label: 'Critical task count',     description: 'Total tasks on the critical path across all projects.',           enabled: true  },
  { id: 'at-risk-tasks',      label: 'At-risk task count',      description: 'Tasks flagged at-risk or overdue.',                              enabled: true  },
  { id: 'baseline-variance',  label: 'Baseline variance',       description: 'Aggregate schedule and cost variance vs. saved baselines.',       enabled: true  },
  { id: 'resource-util',      label: 'Resource utilization',    description: 'Average allocation across resources in member projects.',         enabled: false },
  { id: 'velocity',           label: 'Sprint velocity',         description: 'Avg. story points per sprint across Agile/Hybrid projects.',      enabled: false },
  { id: 'risk-score',         label: 'Risk score',              description: 'Weighted mean of open risk scores (probability × impact).',      enabled: true  },
  { id: 'p80',                label: 'P80 completion date',     description: 'Monte Carlo P80 across all projects (envelope of distributions).', enabled: true  },
];

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      className={[
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        on ? 'bg-brand-primary border-brand-primary' : 'bg-neutral-surface-sunken border-neutral-border',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
          on ? 'translate-x-3.5' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  );
}

/** Program > Rollup KPIs settings page. */
export function ProgramRollupPage() {
  const [kpis, setKpis] = useState<KpiToggle[]>(DEFAULT_KPIS);
  const [rollupPolicy, setRollupPolicy] = useState<'worst' | 'average' | 'weighted'>('worst');

  function toggleKpi(id: string) {
    setKpis((prev) => prev.map((k) => k.id === id ? { ...k, enabled: !k.enabled } : k));
  }

  return (
    <>
    <StubPageBanner pageIssue={527} />
    <StubFieldset disabled>
    <div>
      <SettingsPageTitle
        title="Rollup KPIs"
        subtitle="Choose which health signals roll up to the program level. Only enabled KPIs appear on the program overview."
      />

      <div className="px-6 pb-8 max-w-[720px] space-y-6">
        {/* KPI toggles */}
        <section aria-labelledby="kpi-heading" className="bg-neutral-surface-raised border border-neutral-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-border/55 bg-neutral-surface-sunken">
            <h2 id="kpi-heading" className="text-[13px] font-semibold text-neutral-text-primary">Enabled KPIs</h2>
            <p className="text-[12px] text-neutral-text-secondary mt-0.5">Toggle KPIs visible on the program overview and rollup tiles.</p>
          </div>
          {kpis.map((kpi, i) => (
            <div
              key={kpi.id}
              className={['flex items-center gap-4 px-4 py-3', i < kpis.length - 1 ? 'border-b border-neutral-border/55' : ''].join(' ')}
            >
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-neutral-text-primary">{kpi.label}</div>
                <div className="text-[12px] text-neutral-text-secondary mt-0.5 leading-snug">{kpi.description}</div>
              </div>
              <Toggle on={kpi.enabled} onToggle={() => toggleKpi(kpi.id)} />
            </div>
          ))}
        </section>

        {/* Aggregation policy */}
        <section aria-labelledby="policy-heading" className="bg-neutral-surface-raised border border-neutral-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-border/55">
            <h2 id="policy-heading" className="text-[13px] font-semibold text-neutral-text-primary">Health aggregation policy</h2>
            <p className="text-[12px] text-neutral-text-secondary mt-0.5">How project health signals are combined into the program health dot.</p>
          </div>
          <div className="px-4 py-3 space-y-2">
            {(
              [
                { id: 'worst'    as const, label: 'Worst-case (recommended)', hint: 'Program health = worst health across all projects. One critical project → program is critical.' },
                { id: 'average'  as const, label: 'Average',                  hint: 'Numeric average of health scores. Dilutes a single critical project.' },
                { id: 'weighted' as const, label: 'Task-weighted average',     hint: 'Projects with more tasks carry proportionally more weight in the average.' },
              ]
            ).map((opt) => (
              <label key={opt.id} className="flex items-start gap-2.5 cursor-pointer rounded p-2 hover:bg-neutral-surface-sunken">
                <span
                  className={[
                    'mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors',
                    rollupPolicy === opt.id ? 'border-brand-primary bg-brand-primary' : 'border-neutral-border bg-neutral-surface',
                  ].join(' ')}
                  aria-hidden="true"
                >
                  {rollupPolicy === opt.id && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                </span>
                <input
                  type="radio"
                  name="rollup-policy"
                  value={opt.id}
                  checked={rollupPolicy === opt.id}
                  onChange={() => setRollupPolicy(opt.id)}
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
      </div>
    </div>
    </StubFieldset>
    </>
  );
}
