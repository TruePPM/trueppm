import { useState } from 'react';
import { SettingsPageTitle } from '../SettingsShell';
import { StubFieldset } from '../components/StubFieldset';
import { StubPageBanner } from '../components/StubPageBanner';

type Method = 'agile' | 'waterfall' | 'hybrid' | 'inherit';

const METHODS: Array<{
  id: Exclude<Method, 'inherit'>;
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
    features: ['Sprint planning & retros', 'Story points (Fibonacci)', 'Burndown & velocity'],
  },
  {
    id: 'waterfall',
    label: 'Waterfall',
    tagline: 'Phases, gates, baselines, CPM. No sprints.',
    accent: '#3E8C6D',
    accentBg: '#D3ECE0',
    features: ['WBS → Schedule → Baseline', 'CPM with all 4 dependency types', 'Earned value metrics'],
  },
  {
    id: 'hybrid',
    label: 'Hybrid',
    tagline: 'Phases & gates at top; sprints inside delivery phases.',
    accent: '#C17A10',
    accentBg: '#FFF3CD',
    features: ['Phase gates at program level', '2-week sprints in delivery', 'Gantt outer · Board inner'],
  },
];

/** Project > Methodology settings page. */
export function ProjectMethodologyPage() {
  const [method, setMethod] = useState<Method>('inherit');

  return (
    <>
    <StubPageBanner pageIssue={511} />
    <StubFieldset disabled>
    <div>
      <SettingsPageTitle
        title="Methodology"
        subtitle="Override the workspace delivery model for this project only. 'Inherit' applies the workspace default."
      />

      <div className="px-6 pb-8 max-w-[920px] space-y-6">
        {/* Inherit option */}
        <section aria-labelledby="inherit-heading">
          <h2 id="inherit-heading" className="text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary mb-3">
            Workspace default
          </h2>
          <button
            type="button"
            onClick={() => setMethod('inherit')}
            aria-pressed={method === 'inherit'}
            className={[
              'w-full text-left rounded-lg border p-4 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
              method === 'inherit'
                ? 'border-2 border-brand-primary bg-brand-primary-light'
                : 'border border-neutral-border bg-neutral-surface-raised hover:bg-neutral-surface-sunken',
            ].join(' ')}
          >
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[13px] font-semibold text-neutral-text-primary">Inherit from workspace</span>
                <p className="text-[12px] text-neutral-text-secondary mt-0.5">
                  Automatically applies workspace methodology default (currently Waterfall). Changes when the workspace default changes.
                </p>
              </div>
              {method === 'inherit' && (
                <span className="w-4 h-4 rounded-full flex items-center justify-center bg-brand-primary shrink-0 ml-4">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M3 8l4 4 6-7" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </span>
              )}
            </div>
          </button>
        </section>

        {/* Method cards */}
        <section aria-labelledby="method-heading">
          <h2 id="method-heading" className="text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary mb-3">
            Override for this project
          </h2>
          <div className="grid grid-cols-3 gap-3.5">
            {METHODS.map((m) => {
              const isSelected = method === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMethod(m.id)}
                  aria-pressed={isSelected}
                  className={[
                    'text-left rounded-lg border p-4 transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                    isSelected
                      ? 'border-2'
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
                      <span className="w-4 h-4 rounded-full flex items-center justify-center shrink-0" style={{ background: m.accent, color: '#fff' }}>
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
      </div>
    </div>
    </StubFieldset>
    </>
  );
}
