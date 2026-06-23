import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { SettingsPageTitle } from '../SettingsShell';
import { useProgram } from '@/hooks/useProgram';
import { ROLE_ADMIN } from '@/lib/roles';
import {
  HEALTH_LABEL,
  HEALTH_VARIANT,
  renderKpi,
  useProgramRollup,
  type KpiVariant,
} from '@/features/programs/ProgramOverviewPage';
import {
  useProgramRollupConfig,
  useSaveProgramRollupPolicy,
  useToggleProgramRollupKpi,
  type AggregationPolicy,
  type RollupKpi,
} from './useProgramRollupConfig';

interface KpiMeta {
  id: RollupKpi;
  label: string;
  description: string;
}

interface KpiGroup {
  heading: string;
  kpis: KpiMeta[];
}

// Grouping is presentational only — server stores enabled_kpis as a flat list.
// Three subgroups (5/3/2) per the UX spec; Sarah's VoC asked for grouping to
// keep 10 toggles scannable on a Friday-afternoon settings pass.
const KPI_GROUPS: KpiGroup[] = [
  {
    heading: 'Schedule',
    kpis: [
      {
        id: 'schedule_health',
        label: 'Schedule health',
        description: 'Rollup of project health dots weighted by task count.',
      },
      {
        id: 'schedule_variance',
        label: 'Schedule variance (SV)',
        description:
          'Earned-value schedule variance vs. the saved baseline. Negative = behind plan.',
      },
      {
        id: 'baseline_variance',
        label: 'Baseline variance',
        description: 'Aggregate schedule and cost variance vs. the most recent saved baseline.',
      },
      {
        id: 'critical_tasks',
        label: 'Critical task count',
        description: 'Total tasks on the critical path across all projects in the program.',
      },
      {
        id: 'milestone_health',
        label: 'Milestone health',
        description: 'Share of program milestones on track vs. slipped past their planned date.',
      },
    ],
  },
  {
    heading: 'Risk',
    kpis: [
      {
        id: 'at_risk_tasks',
        label: 'At-risk tasks',
        description: 'Tasks flagged at-risk or already overdue.',
      },
      {
        id: 'risk_score',
        label: 'Risk score',
        description:
          'Weighted mean of open risk scores (probability × impact) across the risk register.',
      },
      {
        id: 'p80_completion',
        label: 'P80 completion date',
        description: 'Monte Carlo P80 — the date by which 80% of simulated outcomes complete.',
      },
    ],
  },
  {
    heading: 'Cost',
    kpis: [
      {
        id: 'cost_variance',
        label: 'Cost variance (CV)',
        description: 'Earned-value cost variance vs. the saved baseline. Negative = over budget.',
      },
      {
        id: 'budget_utilization',
        label: 'Budget utilization',
        description: 'Approved budget consumed to date, aggregated across all projects.',
      },
    ],
  },
];

interface PolicyOption {
  id: AggregationPolicy;
  label: string;
  hint: string;
}

const POLICIES: PolicyOption[] = [
  {
    id: 'worst',
    label: 'Worst-case (recommended)',
    hint: 'Program health = worst health across all projects. One critical project → program is critical.',
  },
  {
    id: 'average',
    label: 'Average',
    hint: 'Numeric average of project health scores. Dilutes a single critical project.',
  },
  {
    id: 'weighted_by_budget',
    label: 'Budget-weighted',
    hint: 'Projects with larger approved budgets carry proportionally more weight in the average.',
  },
  {
    id: 'task_weighted',
    label: 'Task-weighted',
    hint: 'Projects with more tasks carry proportionally more weight in the average.',
  },
];

function Toggle({
  on,
  onToggle,
  disabled,
  ariaLabel,
}: {
  on: boolean;
  onToggle: () => void;
  disabled: boolean;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onToggle();
      }}
      className={[
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        on
          ? 'bg-brand-primary border-brand-primary'
          : 'bg-neutral-surface-sunken border-neutral-border',
        disabled ? 'opacity-60 cursor-not-allowed' : '',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform',
          on ? 'translate-x-3.5' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  );
}

interface InlineToastState {
  message: string;
  variant: 'error' | 'success';
}

const PREVIEW_VARIANT_TEXT: Record<KpiVariant, string> = {
  'on-track': 'text-semantic-on-track',
  'at-risk': 'text-semantic-at-risk',
  critical: 'text-semantic-critical',
  neutral: 'text-neutral-text-primary',
};

const PREVIEW_HEALTH_PILL: Record<KpiVariant, string> = {
  'on-track': 'border-semantic-on-track/40 text-semantic-on-track',
  'at-risk': 'border-semantic-at-risk/40 text-semantic-at-risk',
  critical: 'border-semantic-critical/40 text-semantic-critical',
  neutral: 'border-neutral-border text-neutral-text-disabled',
};

const PREVIEW_POLICY_LABEL: Record<AggregationPolicy, string> = {
  worst: 'Worst-case',
  average: 'Average',
  weighted_by_budget: 'Budget-weighted',
  task_weighted: 'Task-weighted',
};

/**
 * Live "preview against current data" panel (#673). Renders the same computed
 * rollup the program overview shows (`GET /rollup/`, ADR-0088) so an admin sees
 * the effect of the current selection before leaving settings. Reflects the
 * SAVED config: KPI toggles auto-save (the preview refetches once the debounced
 * PATCH lands — the parent invalidates the query), while the policy needs an
 * explicit Save, so a dirty draft shows a hint rather than a stale number.
 */
function RollupPreview({ programId, policyDirty }: { programId: string; policyDirty: boolean }) {
  const { data: rollup, isLoading, isError } = useProgramRollup(programId);

  return (
    <section
      aria-labelledby="preview-heading"
      className="bg-neutral-surface-raised border border-neutral-border rounded-card overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-neutral-border/55">
        <h2 id="preview-heading" className="text-[13px] font-semibold text-neutral-text-primary">
          Preview
        </h2>
        <p className="text-[12px] text-neutral-text-secondary mt-0.5">
          How these settings roll up against your current project data.
        </p>
      </div>

      <div className="px-4 py-3">
        {isLoading && (
          <div
            role="status"
            aria-label="Loading preview"
            className="text-xs text-neutral-text-secondary"
          >
            Loading…
          </div>
        )}
        {isError && (
          <div role="alert" className="text-xs text-semantic-critical">
            Couldn&apos;t load the preview.
          </div>
        )}
        {!isLoading && !isError && rollup && (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`bg-transparent border rounded-chip px-2 py-0.5 text-[12px] font-medium ${PREVIEW_HEALTH_PILL[HEALTH_VARIANT[rollup.program_health]]}`}
                aria-label={`Program health: ${HEALTH_LABEL[rollup.program_health]}`}
              >
                {HEALTH_LABEL[rollup.program_health]}
              </span>
              <span className="text-[12px] text-neutral-text-secondary">
                {PREVIEW_POLICY_LABEL[rollup.aggregation_policy]} across {rollup.project_count}{' '}
                project{rollup.project_count === 1 ? '' : 's'}
              </span>
            </div>

            {policyDirty && (
              <p className="text-[12px] text-neutral-text-disabled mt-2">
                Save the policy to see it reflected in the preview.
              </p>
            )}

            {rollup.project_count === 0 ? (
              <p className="text-[12px] text-neutral-text-secondary mt-3">
                Add projects to the program to preview the rollup.
              </p>
            ) : Object.keys(rollup.kpis).length === 0 ? (
              <p className="text-[12px] text-neutral-text-secondary mt-3">
                No KPIs enabled — toggle one above to preview it.
              </p>
            ) : (
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2">
                {Object.entries(rollup.kpis).map(([key, entry]) => {
                  const k = renderKpi(key, entry);
                  return (
                    <div key={k.key} className="flex items-baseline justify-between gap-3 min-w-0">
                      <dt className="text-[12px] text-neutral-text-secondary truncate">
                        {k.label}
                      </dt>
                      <dd
                        className={`text-[13px] font-medium tppm-mono shrink-0 ${
                          k.muted ? 'text-neutral-text-disabled' : PREVIEW_VARIANT_TEXT[k.variant]
                        }`}
                        title={k.muted ? k.sub : undefined}
                      >
                        {k.value}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Program > Rollup KPIs settings page (#527).
 *
 * Wires the existing settings surface to ``/api/v1/programs/:id/rollup-config/``.
 * Two persistence patterns coexist on the same page because the VoC panel
 * surfaced them as different:
 *   - KPI switches use optimistic PATCH (preference-shaped, low stakes)
 *   - Aggregation policy uses explicit Save with an "Unsaved changes" affordance
 *     (governance-shaped — Alex/Morgan/Marcus flagged silent flips of what
 *     executives see on Monday as a regression risk).
 */
export function ProgramRollupPage() {
  const { programId } = useParams<{ programId: string }>();
  const { data: program } = useProgram(programId);
  const { data: config, isLoading, isError, refetch } = useProgramRollupConfig(programId);
  const toggleKpi = useToggleProgramRollupKpi(programId ?? '');
  const savePolicy = useSaveProgramRollupPolicy(programId ?? '');
  const queryClient = useQueryClient();

  const canEdit = (program?.my_role ?? 0) >= ROLE_ADMIN;

  // Keep the live preview in sync with saved config: KPI toggles auto-save and
  // policy saves both refresh the config query, so invalidate the rollup query
  // whenever the saved selection changes — the preview then recomputes against
  // current project data (#673).
  useEffect(() => {
    if (programId) {
      void queryClient.invalidateQueries({ queryKey: ['program-rollup', programId] });
    }
  }, [config?.enabled_kpis, config?.aggregation_policy, programId, queryClient]);

  // Local draft for the policy radio. Diverges from server state until the
  // user clicks Save; matches server again after a successful save or Discard.
  const [draftPolicy, setDraftPolicy] = useState<AggregationPolicy | null>(null);
  useEffect(() => {
    setDraftPolicy(null);
  }, [config?.aggregation_policy]);

  const [toast, setToast] = useState<InlineToastState | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // 250ms debounce on KPI toggles: rapid-firing several switches collapses
  // into a single PATCH carrying the final ``enabled_kpis`` array. ``pending``
  // is React state (drives the UI) and ``debounceTimer`` is a ref (does not).
  // Setting ``pending`` to non-null switches the renderer onto the local view
  // until the mutation either succeeds (cache becomes truth, clear pending)
  // or errors (revert pending to last known good).
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, setPending] = useState<RollupKpi[] | null>(null);
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);
  // When the server cache updates (mutation success or external refetch),
  // any pending overlay is stale by definition — drop it.
  useEffect(() => {
    setPending(null);
  }, [config?.enabled_kpis]);

  if (!programId) return null;

  // Pending overlay wins over the server cache so the switch animates
  // immediately on click, even while the debounced PATCH is still pending.
  const effectiveKpis = pending ?? config?.enabled_kpis ?? [];
  const enabledSet = new Set<RollupKpi>(effectiveKpis);
  const policyOnServer = config?.aggregation_policy ?? 'worst';
  const policyShown = draftPolicy ?? policyOnServer;
  const policyDirty = draftPolicy !== null && draftPolicy !== policyOnServer;

  function flushToggle(payload: RollupKpi[]) {
    debounceTimer.current = null;
    toggleKpi.mutate(payload, {
      onError: () => {
        // Revert the optimistic overlay back to the server's last-known state.
        setPending(null);
        setToast({ message: 'Could not save change — try again.', variant: 'error' });
      },
    });
  }

  function onToggle(kpi: RollupKpi) {
    if (!canEdit || !config) return;
    const current = pending ?? config.enabled_kpis;
    const next = current.includes(kpi) ? current.filter((k) => k !== kpi) : [...current, kpi];
    setPending(next);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => flushToggle(next), 250);
  }

  function onSavePolicy() {
    if (!canEdit || draftPolicy === null) return;
    savePolicy.mutate(draftPolicy, {
      onSuccess: () => setToast({ message: 'Saved.', variant: 'success' }),
      onError: () => setToast({ message: 'Could not save — try again.', variant: 'error' }),
    });
  }

  return (
    <div>
      <SettingsPageTitle
        title="Rollup KPIs"
        subtitle="Choose which health signals roll up to the program level. Only enabled KPIs appear on the program overview."
        action={
          !canEdit ? (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-chip text-xs font-medium bg-neutral-surface-sunken text-neutral-text-secondary"
              title="Only program admins can edit rollup KPIs"
            >
              Read-only
            </span>
          ) : undefined
        }
      />

      <div className="px-6 pb-8 max-w-[720px] space-y-6">
        {/* KPI toggles */}
        <section
          aria-labelledby="kpi-heading"
          className="bg-neutral-surface-raised border border-neutral-border rounded-card overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-neutral-border/55 bg-neutral-surface-sunken">
            <h2 id="kpi-heading" className="text-[13px] font-semibold text-neutral-text-primary">
              Enabled KPIs
            </h2>
            <p className="text-[12px] text-neutral-text-secondary mt-0.5">
              Toggle KPIs visible on the program overview and rollup tiles.
            </p>
          </div>

          {isLoading && (
            <div
              role="status"
              aria-label="Loading KPI settings"
              className="px-4 py-6 text-xs text-neutral-text-secondary"
            >
              Loading…
            </div>
          )}

          {isError && (
            <div role="alert" className="px-4 py-6 flex items-center gap-3 text-xs">
              <span className="text-semantic-critical">Couldn&apos;t load KPI settings.</span>
              <button
                type="button"
                onClick={() => void refetch()}
                className="h-7 px-2 rounded-control border border-neutral-border text-xs font-medium text-neutral-text-secondary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Retry
              </button>
            </div>
          )}

          {!isLoading &&
            !isError &&
            config &&
            KPI_GROUPS.map((group, gi) => (
              <div key={group.heading}>
                <h3
                  className={[
                    'px-4 py-1.5 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary bg-neutral-surface-sunken/40',
                    gi === 0 ? '' : 'border-t border-neutral-border/55',
                  ].join(' ')}
                >
                  {group.heading}
                </h3>
                {group.kpis.map((kpi, i) => (
                  <div
                    key={kpi.id}
                    className={[
                      'flex items-center gap-4 px-4 py-3',
                      i < group.kpis.length - 1 ? 'border-b border-neutral-border/55' : '',
                    ].join(' ')}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-neutral-text-primary">
                        {kpi.label}
                      </div>
                      <div className="text-[12px] text-neutral-text-secondary mt-0.5 leading-snug">
                        {kpi.description}
                      </div>
                    </div>
                    <Toggle
                      on={enabledSet.has(kpi.id)}
                      onToggle={() => onToggle(kpi.id)}
                      disabled={!canEdit}
                      ariaLabel={kpi.label}
                    />
                  </div>
                ))}
              </div>
            ))}
        </section>

        {/* Aggregation policy */}
        <section
          aria-labelledby="policy-heading"
          className="bg-neutral-surface-raised border border-neutral-border rounded-card overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-neutral-border/55">
            <h2 id="policy-heading" className="text-[13px] font-semibold text-neutral-text-primary">
              Health aggregation policy
            </h2>
            <p className="text-[12px] text-neutral-text-secondary mt-0.5">
              How project health signals are combined into the program health dot.
            </p>
          </div>

          {isLoading && (
            <div
              role="status"
              aria-label="Loading policy"
              className="px-4 py-6 text-xs text-neutral-text-secondary"
            >
              Loading…
            </div>
          )}

          {isError && (
            <div role="alert" className="px-4 py-6 flex items-center gap-3 text-xs">
              <span className="text-semantic-critical">Couldn&apos;t load policy.</span>
              <button
                type="button"
                onClick={() => void refetch()}
                className="h-7 px-2 rounded-control border border-neutral-border text-xs font-medium text-neutral-text-secondary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Retry
              </button>
            </div>
          )}

          {!isLoading && !isError && config && (
            <fieldset className="px-4 py-3 space-y-2" disabled={!canEdit}>
              <legend className="sr-only">Health aggregation policy</legend>
              {POLICIES.map((opt) => (
                <label
                  key={opt.id}
                  className={[
                    'flex items-start gap-2.5 rounded-control p-2',
                    canEdit ? 'cursor-pointer hover:bg-neutral-surface-sunken' : 'opacity-80',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors',
                      policyShown === opt.id
                        ? 'border-brand-primary bg-brand-primary'
                        : 'border-neutral-border bg-neutral-surface',
                    ].join(' ')}
                    aria-hidden="true"
                  >
                    {policyShown === opt.id && (
                      <span className="w-1.5 h-1.5 rounded-full bg-white" />
                    )}
                  </span>
                  <input
                    type="radio"
                    name="rollup-policy"
                    value={opt.id}
                    checked={policyShown === opt.id}
                    onChange={() => setDraftPolicy(opt.id)}
                    className="sr-only"
                  />
                  <span className="flex flex-col">
                    <span className="text-[13px] font-medium text-neutral-text-primary">
                      {opt.label}
                    </span>
                    <span className="text-[12px] text-neutral-text-secondary">{opt.hint}</span>
                  </span>
                </label>
              ))}

              {policyDirty && (
                <div
                  role="status"
                  aria-live="polite"
                  className="mt-2 flex items-center justify-between gap-3 px-3 py-2 rounded-card border border-brand-primary/40 bg-brand-primary/5"
                >
                  <span className="text-[12px] font-medium text-neutral-text-primary">
                    <span aria-hidden="true">▲</span> Unsaved changes
                  </span>
                  <span className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setDraftPolicy(null)}
                      disabled={savePolicy.isPending}
                      className="h-7 px-2.5 rounded-control border border-neutral-border text-xs font-medium text-neutral-text-secondary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed"
                    >
                      Discard
                    </button>
                    <button
                      type="button"
                      onClick={onSavePolicy}
                      disabled={savePolicy.isPending}
                      className="h-7 px-3 rounded-control bg-brand-primary text-xs font-semibold text-white hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed"
                    >
                      {savePolicy.isPending ? 'Saving…' : 'Save'}
                    </button>
                  </span>
                </div>
              )}
            </fieldset>
          )}
        </section>

        {/* Live preview (#673) */}
        <RollupPreview programId={programId} policyDirty={policyDirty} />

        {/* Inline toast */}
        {toast && (
          <div
            role={toast.variant === 'error' ? 'alert' : 'status'}
            aria-live={toast.variant === 'error' ? 'assertive' : 'polite'}
            className={[
              'fixed bottom-6 right-6 z-50 px-4 py-2.5 rounded-card border border-neutral-border text-[13px] font-medium',
              toast.variant === 'error'
                ? 'bg-semantic-critical text-white'
                : 'bg-neutral-text-primary text-white',
            ].join(' ')}
          >
            {toast.message}
          </div>
        )}
      </div>
    </div>
  );
}
