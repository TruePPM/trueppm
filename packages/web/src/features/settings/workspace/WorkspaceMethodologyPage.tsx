import { useState } from 'react';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { StubFieldset } from '../components/StubFieldset';

type Method = 'agile' | 'waterfall' | 'hybrid';

const METHODS: Array<{
  id: Method;
  label: string;
  tagline: string;
  accent: string;
  accentBg: string;
  features: string[];
}> = [
  {
    id: 'agile',
    label: 'Agile',
    tagline: 'Sprints, story points, velocity. No baselines, no critical path.',
    accent: '#7C3AED',
    accentBg: 'rgba(124,58,237,.10)',
    features: ['Sprint planning & retros', 'Story points (Fibonacci)', 'Burndown & velocity', 'No baselines or CPM'],
  },
  {
    id: 'waterfall',
    label: 'Waterfall',
    tagline: 'Phases, gates, baselines, CPM. No sprints.',
    accent: '#1C6B3A',
    accentBg: '#D4EDDA',
    features: ['WBS → Schedule → Baseline', 'CPM with all 4 dependency types', 'Earned value metrics', 'No sprints or story points'],
  },
  {
    id: 'hybrid',
    label: 'Hybrid',
    tagline: 'Phases & gates at the top; sprints inside delivery phases.',
    accent: '#C17A10',
    accentBg: '#FFF3CD',
    features: ['Phase gates at program level', '2-week sprints in delivery', 'Gantt outer · Board inner', 'Mixed estimation'],
  },
];

/** Workspace > Methodology defaults page. */
export function WorkspaceMethodologyPage() {
  const [selected, setSelected] = useState<Method>('waterfall');
  const [overridePolicy, setOverridePolicy] = useState<'inherit' | 'suggest' | 'enforce'>('suggest');

  return (
    <StubFieldset disabled>
    <div>
      <SettingsPageTitle
        title="Methodology defaults"
        subtitle="Set the default delivery model for all new projects. PMs can override per project unless you enforce a single method."
      />

      <div className="px-6 pb-8 max-w-[960px] space-y-6">
        {/* Method cards */}
        <section aria-labelledby="method-heading">
          <h2 id="method-heading" className="text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary mb-3">
            Default delivery model
          </h2>
          <div className="grid grid-cols-3 gap-3.5">
            {METHODS.map((m) => {
              const isSelected = selected === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSelected(m.id)}
                  aria-pressed={isSelected}
                  className={[
                    'text-left rounded-lg border p-4 transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                    isSelected
                      ? 'border-2 border-[currentColor]'
                      : 'border border-neutral-border bg-neutral-surface-raised hover:bg-neutral-surface-sunken',
                  ].join(' ')}
                  style={isSelected ? { borderColor: m.accent, background: m.accentBg, color: m.accent } : {}}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-semibold"
                      style={{ background: m.accentBg, color: m.accent }}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60" aria-hidden="true" />
                      {m.label}
                    </span>
                    {isSelected && (
                      <span className="w-4 h-4 rounded-full flex items-center justify-center" style={{ background: m.accent, color: '#fff' }}>
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="M3 8l4 4 6-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] text-neutral-text-secondary mb-3 leading-snug">{m.tagline}</p>
                  <ul className="space-y-1">
                    {m.features.map((f) => (
                      <li key={f} className="text-[11px] text-neutral-text-secondary flex items-start gap-1.5">
                        <span className="w-1 h-1 rounded-full bg-neutral-text-disabled mt-[5px] shrink-0" aria-hidden="true" />
                        {f}
                      </li>
                    ))}
                  </ul>
                </button>
              );
            })}
          </div>
        </section>

        {/* Override policy */}
        <section aria-labelledby="policy-heading" className="rounded-lg border border-neutral-border bg-neutral-surface-raised overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-border/55">
            <h2 id="policy-heading" className="text-[13px] font-semibold text-neutral-text-primary">
              Project override policy
            </h2>
            <p className="text-[12px] text-neutral-text-secondary mt-0.5">
              Controls how PMs can deviate from the workspace default.
            </p>
          </div>
          <div className="px-4 py-3 space-y-2">
            {(
              [
                { id: 'inherit',  label: 'Inherit (recommended)', hint: 'New projects silently adopt the workspace default. PMs can change it at any time.' },
                { id: 'suggest',  label: 'Suggest',                hint: 'New projects pre-fill the default but show a prompt during setup so PMs notice the choice.' },
                { id: 'enforce',  label: 'Enforce',                hint: 'PMs cannot change the methodology. Good for org-wide compliance.' },
              ] as const
            ).map((opt) => (
              <label key={opt.id} className="flex items-start gap-2.5 cursor-pointer rounded p-2 hover:bg-neutral-surface-sunken group">
                <span
                  className={[
                    'mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors',
                    overridePolicy === opt.id
                      ? 'border-brand-primary bg-brand-primary'
                      : 'border-neutral-border bg-neutral-surface',
                  ].join(' ')}
                  aria-hidden="true"
                >
                  {overridePolicy === opt.id && (
                    <span className="w-1.5 h-1.5 rounded-full bg-white" />
                  )}
                </span>
                <input
                  type="radio"
                  name="override-policy"
                  value={opt.id}
                  checked={overridePolicy === opt.id}
                  onChange={() => setOverridePolicy(opt.id)}
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

        {/* Methodology distribution info */}
        <section aria-labelledby="dist-heading" className="rounded-lg border border-neutral-border overflow-hidden">
          <div className="px-4 py-3 bg-neutral-surface-sunken border-b border-neutral-border/55">
            <h2 id="dist-heading" className="text-[13px] font-semibold text-neutral-text-primary">
              Current distribution
            </h2>
            <p className="text-[12px] text-neutral-text-secondary mt-0.5">Across all active projects in this workspace.</p>
          </div>
          <div className="px-4 py-3 space-y-2">
            {[
              { method: 'Waterfall', count: 8, total: 14, color: '#1C6B3A' },
              { method: 'Hybrid',    count: 4, total: 14, color: '#C17A10' },
              { method: 'Agile',     count: 2, total: 14, color: '#7C3AED' },
            ].map(({ method, count, total, color }) => (
              <div key={method} className="flex items-center gap-3">
                <span className="text-[13px] text-neutral-text-primary w-20 shrink-0">{method}</span>
                <div className="flex-1 h-2 rounded bg-neutral-surface-sunken overflow-hidden">
                  <div
                    className="h-full rounded transition-all"
                    style={{ width: `${(count / total) * 100}%`, background: color }}
                  />
                </div>
                <span className="tppm-mono text-[12px] text-neutral-text-secondary w-16 text-right shrink-0">
                  {count} / {total}
                </span>
              </div>
            ))}
          </div>
        </section>

        <FieldRow label="Sprint defaults" hint="Applied to all new Agile/Hybrid projects that don't override.">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-neutral-text-secondary">Length:</span>
            <div className="flex items-center h-8 rounded border border-neutral-border bg-neutral-surface-raised px-2.5 w-[120px] gap-2 text-[13px]">
              <span>2 weeks</span>
              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="text-neutral-text-secondary ml-auto">
                <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
            </div>
            <span className="text-[13px] text-neutral-text-secondary">Estimation:</span>
            <div className="flex items-center h-8 rounded border border-neutral-border bg-neutral-surface-raised px-2.5 w-[180px] gap-2 text-[13px]">
              <span>Story points (Fibonacci)</span>
              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="text-neutral-text-secondary ml-auto">
                <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
            </div>
          </div>
        </FieldRow>
      </div>
    </div>
    </StubFieldset>
  );
}
