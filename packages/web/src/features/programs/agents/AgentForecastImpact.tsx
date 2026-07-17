import {
  HEALTH_LABEL,
  HEALTH_VARIANT,
  useProgramRollup,
  type KpiVariant,
} from '@/features/programs/ProgramOverviewPage';

interface AgentForecastImpactProps {
  programId: string | undefined;
  /** Jump to the Activity sub-view (the "View in Activity" affordance). */
  onViewActivity: () => void;
}

const VARIANT_TEXT: Record<KpiVariant, string> = {
  'on-track': 'text-semantic-on-track',
  'at-risk': 'text-semantic-at-risk',
  critical: 'text-semantic-critical',
  neutral: 'text-neutral-text-primary',
};

/**
 * "Given what the agents have actually done, when does this program finish?"
 * (#2020, design §4.4). Per design §7 this reuses the program forecast rollup the
 * Program Overview already consumes — it does NOT invent a program-level Monte
 * Carlo aggregate. Agent-completed work is already folded into the committed task
 * set the forecast runs on, so the rollup *is* the agent-actuals-conditioned
 * forecast by construction; the only agent-specific addition is the honest
 * contribution strip (N=0 until agents do measured write-work at 0.6+).
 */
export function AgentForecastImpact({ programId, onViewActivity }: AgentForecastImpactProps) {
  const { data, isLoading, isError } = useProgramRollup(programId);

  if (isLoading) {
    return (
      <div
        className="h-24 max-w-sm rounded-card border border-neutral-border bg-neutral-surface-raised motion-safe:animate-pulse"
        role="status"
        aria-label="Loading forecast"
      />
    );
  }

  if (isError || !data) {
    return (
      <div
        role="alert"
        className="rounded-card border border-semantic-critical/30 bg-semantic-critical-bg px-4 py-3 text-sm text-semantic-critical"
      >
        Couldn&rsquo;t load the program forecast. Try again.
      </div>
    );
  }

  const p80 = data.kpis.p80_completion;
  const hasForecast = p80?.available === true && p80.value != null;
  const variant = HEALTH_VARIANT[data.program_health];

  return (
    <div className="max-w-xl">
      {hasForecast ? (
        <div className="flex flex-col gap-1 rounded-card border border-neutral-border bg-neutral-surface-raised p-4">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-text-secondary">
            P80 completion
          </span>
          <span className={`tppm-mono text-2xl font-semibold ${VARIANT_TEXT[variant]}`}>
            {String(p80.value)}
          </span>
          <span className="text-xs text-neutral-text-disabled">
            Program health: {HEALTH_LABEL[data.program_health]} · across {data.project_count}{' '}
            {data.project_count === 1 ? 'project' : 'projects'}
          </span>
        </div>
      ) : (
        <div
          role="status"
          className="rounded-card border border-dashed border-neutral-border bg-neutral-surface-sunken px-4 py-6 text-center text-sm text-neutral-text-secondary"
        >
          No saved Monte Carlo run for this program yet. Run a forecast on a member project to see
          the program&rsquo;s P80 completion here.
        </div>
      )}

      <div className="mt-4 border-t border-neutral-border pt-3">
        <h3 className="m-0 mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
          Agent contribution
        </h3>
        <p className="m-0 text-sm text-neutral-text-secondary">
          No agent-completed work yet — this forecast reflects the human-run plan. Agent actuals
          will fold in here as agents complete tasks.
        </p>
        <button
          type="button"
          onClick={onViewActivity}
          className="mt-2 text-sm font-medium text-brand-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
        >
          View in Activity →
        </button>
      </div>
    </div>
  );
}
