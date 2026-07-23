import { useCallback, useEffect, useState } from 'react';
import { SettingsPageTitle } from '../SettingsShell';
import { FieldHelp } from '@/components/FieldHelp';
import { EnterpriseBadge } from '../components/EnterpriseBadge';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { useUpdateWorkspaceSettings } from '../hooks/useUpdateWorkspaceSettings';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { ESTIMATION_SCALE_HINT, ESTIMATION_SCALE_OPTIONS } from '../estimationScale';
import { IDENTITY_AMBER, IDENTITY_SAGE, IDENTITY_VIOLET } from '@/lib/identityColors';
import type { EstimationScale, MethodologyOverridePolicy, ProgramMethodology } from '@/api/types';

/**
 * Workspace > Methodology defaults page (ADR-0107, issue 955 / issue 1169).
 *
 * The workspace is the non-null ROOT of the Workspace → Program → Project
 * methodology cascade. `methodology` is the default delivery model new programs
 * and projects start from; `methodologyOverridePolicy` governs whether lower
 * scopes may deviate:
 *  - SUGGEST (default) → lower scopes may override; the workspace value only
 *    pre-fills.
 *  - INHERIT → the workspace default wins everywhere; lower-scope pickers are
 *    read-only.
 *  - ENFORCE → hard lock. Enterprise-only (trueppm-enterprise#144); the OSS
 *    surface disables the radio and shows the upsell badge, and the server
 *    degrades ENFORCE to SUGGEST when no enterprise provider is registered.
 *
 * Unlike the iteration-label policy radios, INHERIT is a first-class OSS option
 * here because methodology is NOT-NULL (there is no null "inherit" sentinel per
 * scope) — the workspace policy IS the inheritance switch.
 */

const METHODS: Array<{
  id: ProgramMethodology;
  label: string;
  tagline: string;
  accent: string;
  accentBg: string;
  features: string[];
}> = [
  {
    id: 'AGILE',
    label: 'Agile',
    tagline: 'Sprints, story points, velocity. No baselines, no critical path.',
    // Identity accents are single-sourced (lib/identityColors); the soft
    // accentBg washes stay local — they are per-method design values, not the
    // shared identity hue.
    accent: IDENTITY_VIOLET,
    accentBg: 'rgba(124,58,237,.10)',
    features: [
      'Sprint planning & retros',
      'Story points (Fibonacci)',
      'Burndown & velocity',
      'No baselines or CPM',
    ],
  },
  {
    id: 'WATERFALL',
    label: 'Waterfall',
    tagline: 'Phases, gates, baselines, CPM. No sprints.',
    accent: IDENTITY_SAGE,
    accentBg: '#D3ECE0',
    features: [
      'WBS → Schedule → Baseline',
      'CPM with all 4 dependency types',
      'Earned value metrics',
      'No sprints or story points',
    ],
  },
  {
    id: 'HYBRID',
    label: 'Hybrid',
    tagline: 'Phases & gates at the top; sprints inside delivery phases.',
    accent: IDENTITY_AMBER,
    accentBg: '#FFF3CD',
    features: [
      'Phase gates at program level',
      '2-week sprints in delivery',
      'Gantt outer · Board inner',
      'Mixed estimation',
    ],
  },
];

export function WorkspaceMethodologyPage() {
  const { data: ws, isLoading } = useWorkspaceSettings();
  const updateSettings = useUpdateWorkspaceSettings();

  const [methodology, setMethodology] = useState<ProgramMethodology>('HYBRID');
  const [overridePolicy, setOverridePolicy] = useState<MethodologyOverridePolicy>('suggest');
  // Workspace-wide default estimation scale (ADR-0510, #2027) — the non-null root
  // of the cascade. No override policy: freely overridable at every scope.
  const [estimationScale, setEstimationScale] = useState<EstimationScale>('fibonacci');

  const [initial, setInitial] = useState<{
    methodology: ProgramMethodology;
    overridePolicy: MethodologyOverridePolicy;
    estimationScale: EstimationScale;
  }>({ methodology: 'HYBRID', overridePolicy: 'suggest', estimationScale: 'fibonacci' });

  // Seed local state once the query resolves (or re-resolves after a save).
  useEffect(() => {
    if (!ws) return;
    const snap = {
      methodology: ws.methodology,
      overridePolicy: ws.methodologyOverridePolicy,
      estimationScale: ws.estimationScale,
    };
    setMethodology(snap.methodology);
    setOverridePolicy(snap.overridePolicy);
    setEstimationScale(snap.estimationScale);
    setInitial(snap);
  }, [ws]);

  const values = { methodology, overridePolicy, estimationScale };

  const onSave = useCallback(async () => {
    await updateSettings.mutateAsync({
      methodology,
      methodologyOverridePolicy: overridePolicy,
      estimationScale,
    });
    setInitial({ methodology, overridePolicy, estimationScale });
  }, [methodology, overridePolicy, estimationScale, updateSettings]);

  const onReset = useCallback(() => {
    setMethodology(initial.methodology);
    setOverridePolicy(initial.overridePolicy);
    setEstimationScale(initial.estimationScale);
  }, [initial]);

  useDirtyForm({ values, initialValues: initial, onSave, onReset, apiReady: true });

  if (isLoading || !ws) {
    return (
      <div className="px-6 py-8 space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-card bg-neutral-surface-raised motion-safe:animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <SettingsPageTitle
        title="Methodology defaults"
        subtitle="Set the default planning methodology (delivery model) for all new programs and projects. They can override it per scope unless you require a single method."
      />

      <div className="px-6 pb-8 max-w-[960px] space-y-6">
        {/* Method cards */}
        <section aria-labelledby="method-heading">
          <div className="flex items-center gap-1.5 mb-3">
            <h2
              id="method-heading"
              className="text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary"
            >
              Default methodology
            </h2>
            <FieldHelp
              label="Default methodology"
              body="The default planning model new programs and projects start from — Waterfall (phases, gates, baselines, and CPM), Agile (sprints, story points, and velocity), or Hybrid (phase gates at the top with sprints inside delivery). Lower scopes may pick their own unless you require a single method below."
              docHref="features/methodology-preset/#methodology-inheritance"
            />
          </div>
          <div className="grid grid-cols-3 gap-3.5" role="radiogroup" aria-labelledby="method-heading">
            {METHODS.map((m) => {
              const isSelected = methodology === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMethodology(m.id)}
                  role="radio"
                  aria-checked={isSelected}
                  className={[
                    'text-left rounded-card border p-4 transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                    isSelected
                      ? 'border-2 border-[currentColor]'
                      : 'border border-neutral-border bg-neutral-surface-raised hover:bg-neutral-surface-sunken',
                  ].join(' ')}
                  style={
                    isSelected
                      ? { borderColor: m.accent, background: m.accentBg, color: m.accent }
                      : {}
                  }
                >
                  <div className="flex items-center justify-between mb-2">
                    <span
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-chip text-[11px] font-semibold"
                      style={{ background: m.accentBg, color: m.accent }}
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-current opacity-60"
                        aria-hidden="true"
                      />
                      {m.label}
                    </span>
                    {isSelected && (
                      <span
                        className="w-4 h-4 rounded-full flex items-center justify-center"
                        style={{ background: m.accent, color: '#fff' }}
                      >
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path
                            d="M3 8l4 4 6-7"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] text-neutral-text-secondary mb-3 leading-snug">
                    {m.tagline}
                  </p>
                  <ul className="space-y-1">
                    {m.features.map((f) => (
                      <li
                        key={f}
                        className="text-[11px] text-neutral-text-secondary flex items-start gap-1.5"
                      >
                        <span
                          className="w-1 h-1 rounded-full bg-neutral-text-disabled mt-[5px] shrink-0"
                          aria-hidden="true"
                        />
                        {f}
                      </li>
                    ))}
                  </ul>
                </button>
              );
            })}
          </div>
        </section>

        {/* Estimation scale (ADR-0510, #2027). The workspace is the non-null root; no
            override policy — programs and projects override it freely. */}
        <section aria-labelledby="estimation-scale-heading">
          <div className="flex items-center gap-1.5 mb-3">
            <h2
              id="estimation-scale-heading"
              className="text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary"
            >
              Default estimation scale
            </h2>
            <FieldHelp
              label="Default estimation scale"
              body="The scale programs and projects use to size work — story points (Fibonacci), hours, or T-shirt sizes. This is the starting default; every program and project can freely pick its own."
              docHref="features/methodology-preset/"
            />
          </div>
          <div className="relative inline-block w-[280px]">
            <label htmlFor="workspace-estimation-scale" className="sr-only">
              Default estimation scale
            </label>
            <select
              id="workspace-estimation-scale"
              value={estimationScale}
              onChange={(e) => setEstimationScale(e.target.value as EstimationScale)}
              className="w-full h-8 pl-2.5 pr-8 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              {ESTIMATION_SCALE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <svg
              className="pointer-events-none absolute right-2.5 top-2.5 text-neutral-text-secondary"
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <p className="mt-1.5 text-[12px] text-neutral-text-secondary max-w-[480px]">
            {ESTIMATION_SCALE_HINT}
          </p>
        </section>

        {/* Override policy */}
        <section
          aria-labelledby="policy-heading"
          className="rounded-card border border-neutral-border bg-neutral-surface-raised overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-neutral-border/55">
            <div className="flex items-center gap-1.5">
              <h2 id="policy-heading" className="text-[13px] font-semibold text-neutral-text-primary">
                Program &amp; project override policy
              </h2>
              <FieldHelp
                label="Override policy"
                body="Controls whether programs and projects may deviate from the workspace methodology. Suggest pre-fills the default but lets each scope change it; Inherit makes the default win everywhere and per-scope pickers read-only; Enforce is a hard lock available in TruePPM Enterprise."
                docHref="features/methodology-preset/#methodology-inheritance"
              />
            </div>
            <p className="text-[12px] text-neutral-text-secondary mt-0.5">
              Controls how programs and projects deviate from the workspace default.
            </p>
          </div>
          <div className="px-4 py-3 space-y-2">
            {(
              [
                {
                  id: 'suggest',
                  label: 'Suggest (recommended)',
                  hint: 'New programs and projects pre-fill the default but PMs can change it per scope.',
                  enterprise: false,
                },
                {
                  id: 'inherit',
                  label: 'Inherit',
                  hint: 'Every program and project follows the workspace default. Per-scope pickers are read-only.',
                  enterprise: false,
                },
                {
                  id: 'enforce',
                  label: 'Enforce',
                  hint: 'The workspace default is mandatory and cannot be overridden. Good for org-wide compliance.',
                  enterprise: true,
                },
              ] as const
            ).map((opt) => {
              const checked = overridePolicy === opt.id;
              const disabled = opt.enterprise;
              return (
                <label
                  key={opt.id}
                  className={[
                    'flex items-start gap-2.5 rounded-card p-2 group',
                    disabled
                      ? 'cursor-not-allowed'
                      : 'cursor-pointer hover:bg-neutral-surface-sunken',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors',
                      checked && !disabled
                        ? 'border-brand-primary bg-brand-primary'
                        : 'border-neutral-border bg-neutral-surface',
                    ].join(' ')}
                    aria-hidden="true"
                  >
                    {checked && !disabled && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                  </span>
                  <input
                    type="radio"
                    name="methodology-override-policy"
                    value={opt.id}
                    checked={checked}
                    disabled={disabled}
                    readOnly={disabled}
                    // A disabled radio conveys nothing to a screen reader beyond
                    // "unavailable" — the visual EnterpriseBadge next to the label
                    // doesn't reach non-visual users, so the reason is spelled out
                    // via an sr-only span (accessibility gap fixed here, web-rule 265 / #2001).
                    aria-describedby={disabled ? 'methodology-enforce-enterprise-hint' : undefined}
                    onChange={() => {
                      if (!disabled) setOverridePolicy(opt.id);
                    }}
                    className="sr-only"
                  />
                  <span className="flex flex-col">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className={[
                          'text-[13px] font-medium',
                          disabled ? 'text-neutral-text-disabled' : 'text-neutral-text-primary',
                        ].join(' ')}
                      >
                        {opt.label}
                      </span>
                      {/* ENFORCE is an Enterprise hard lock (ADR-0107); disabled on the
                          OSS surface with the community-only upsell badge. The server
                          degrades ENFORCE to SUGGEST when no enterprise provider is
                          registered, so storing it is harmless. */}
                      {opt.enterprise && <EnterpriseBadge />}
                    </span>
                    <span className="text-[12px] text-neutral-text-secondary">{opt.hint}</span>
                  </span>
                </label>
              );
            })}
            <span id="methodology-enforce-enterprise-hint" className="sr-only">
              Enforce requires TruePPM Enterprise.
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
