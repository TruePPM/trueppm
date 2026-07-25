import { useEffect, useRef, useState } from 'react';
import type { Task } from '@/types';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { useRunMonteCarlo } from '@/hooks/useRunMonteCarlo';
import { formatRelative } from '@/lib/formatRelative';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { MonteCarloHistogram } from './MonteCarloHistogram';
import { SensitivityList } from './SensitivityList';
import { MonteCarloDetailPanel } from './MonteCarloDetailPanel';
import { ForecastHistorySection } from './ForecastHistorySection';

interface Props {
  projectId?: string;
  /** Loaded tasks — joined by id to name the sensitivity bars and forwarded to
   *  the detail panel for the duration-driver section. */
  tasks: Task[];
  /**
   * ISO date of the deterministic CPM finish (max scheduled task finish).
   * Null when no tasks. Used to compute the P80 risk delta (+Nd) shown on the
   * P80 chip and gate the detail panel's "Risk delta vs CPM" section.
   */
  cpmFinish?: string | null;
  /**
   * Increments whenever any task mutation (drag, resize, etc.) succeeds. Causes
   * the bar to enter the "stale — rerun for updated forecast" state.
   */
  mutationVersion?: number;
}

const EXPANDED_KEY = 'schedule.insightsExpanded';

function readExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === 'true';
  } catch {
    return false;
  }
}

const BTN_CLS =
  'inline-flex items-center h-7 px-3 rounded-control border border-neutral-border bg-neutral-surface ' +
  'text-xs font-medium text-neutral-text-primary ' +
  'hover:bg-neutral-surface-raised disabled:opacity-50 disabled:cursor-not-allowed ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';

/** Persist the expanded/collapsed choice; private-mode failures fall back to session memory. */
function persistExpanded(next: boolean): void {
  try {
    localStorage.setItem(EXPANDED_KEY, String(next));
  } catch {
    // Private mode / SSR — the in-memory value still drives the session.
  }
}

type MonteCarloResult = NonNullable<ReturnType<typeof useMonteCarloResult>['data']>;

/**
 * Tracks the "stale — rerun for updated forecast" machinery: marks stale when a
 * task mutation fires, and clears it when a fresh simulation result arrives.
 * Extracted from ScheduleForecastBar (#2081) — behavior verbatim.
 */
function useForecastStaleness(
  mutationVersion: number,
  result: MonteCarloResult | undefined,
  runMcPending: boolean,
): boolean {
  const [isStale, setIsStale] = useState(false);
  const seenLastRunAt = useRef<string | undefined>(undefined);
  const seenMutationVersion = useRef(mutationVersion);

  useEffect(() => {
    if (mutationVersion !== seenMutationVersion.current) {
      seenMutationVersion.current = mutationVersion;
      if (result) setIsStale(true);
    }
  }, [mutationVersion, result]);

  useEffect(() => {
    if (result?.lastRunAt && result.lastRunAt !== seenLastRunAt.current) {
      seenLastRunAt.current = result.lastRunAt;
      setIsStale(false);
    }
  }, [result?.lastRunAt]);

  return runMcPending || isStale;
}

interface ForecastEmptyStateProps {
  isLoading: boolean;
  loadFailed: boolean;
  runMcIsError: boolean;
  runMcIsPending: boolean;
  onRun: () => void;
  onRetry: () => void;
}

/**
 * No-result state — the ONLY "Run a simulation" prompt on the Schedule view now
 * (the old MonteCarloRow + ScheduleInsightsBar double-claim is gone). A genuine
 * load failure (a 404 "never run" is mapped to no-error by the hook) is kept
 * distinct from the cold-start prompt so it doesn't read as "never run" (#1938) —
 * and it offers a cheap Retry (refetch) rather than forcing a recompute.
 */
function ForecastEmptyState({
  isLoading,
  loadFailed,
  runMcIsError,
  runMcIsPending,
  onRun,
  onRetry,
}: ForecastEmptyStateProps) {
  return (
    <section
      className="hidden md:flex flex-row items-center gap-3 flex-shrink-0 border-t border-neutral-border bg-neutral-surface px-5 py-2.5"
      aria-label={
        loadFailed
          ? 'Schedule forecast — could not load'
          : 'Schedule forecast — no simulation run yet'
      }
    >
      <span className="text-xs font-semibold text-neutral-text-primary">Forecast</span>
      <span
        className={`text-xs ${loadFailed ? 'text-semantic-critical' : 'text-neutral-text-secondary'}`}
        {...(loadFailed ? { role: 'alert' } : {})}
      >
        {isLoading
          ? 'Loading forecast…'
          : loadFailed
            ? "Couldn't load the forecast."
            : runMcIsError
              ? 'Could not run simulation. Try again.'
              : 'Run a simulation to see P50/P80/P95 finish-date probabilities.'}
      </span>
      {loadFailed ? (
        <button type="button" onClick={onRetry} className={`ml-auto ${BTN_CLS}`}>
          Retry
        </button>
      ) : (
        <button
          type="button"
          onClick={onRun}
          disabled={runMcIsPending || isLoading}
          className={`ml-auto ${BTN_CLS}`}
        >
          {runMcIsPending ? 'Running…' : 'Run Monte Carlo'}
        </button>
      )}
    </section>
  );
}

interface ForecastChip {
  label: string;
  iso: string;
  border: string;
  text: string;
  suffix: string;
}

/** P50/P80/P95 chip descriptors; P80 carries the server-owned (+Nd) risk suffix. */
function buildForecastChips(result: MonteCarloResult, showDelta: boolean): ForecastChip[] {
  return [
    {
      label: 'P50',
      iso: result.p50,
      border: 'border-semantic-on-track/40',
      text: 'text-semantic-on-track',
      suffix: '',
    },
    {
      label: 'P80',
      iso: result.p80,
      border: 'border-semantic-at-risk/40',
      text: 'text-semantic-at-risk',
      suffix: showDelta ? ` (+${result.deltaVsCpm.p80}d)` : '',
    },
    {
      label: 'P95',
      iso: result.p95,
      border: 'border-semantic-critical/40',
      text: 'text-semantic-critical',
      suffix: '',
    },
  ];
}

/**
 * The single, consolidated Monte Carlo forecast surface for the Schedule view
 * (ADR-0144, web rule 189). Replaces the former two-surface split — the top
 * `MonteCarloRow` and the bottom `ScheduleInsightsBar` — which rendered the
 * percentiles up to three times and disagreed on the calendar day because of a
 * timezone bug.
 *
 * Desktop-only docked bottom bar (`hidden md:block`); mobile uses
 * `MobileMonteCarloCard`. It owns the MC hooks, the stale/recomputing machinery,
 * the single "Run a simulation" empty state, the P50/P80/P95 chips rendered
 * once (P80 = the commit, accented), the maximize/minimize toggle (persisted to
 * `localStorage['schedule.insightsExpanded']`), and the Rerun + Details actions.
 * Expanded, it shows the histogram, the sensitivity tornado, and the run-history
 * disclosure. All forecast dates route through `lib/formatUtcDate`.
 */
export function ScheduleForecastBar({
  projectId,
  tasks,
  cpmFinish,
  mutationVersion = 0,
}: Props) {
  const { data: result, isLoading, error, refetch } = useMonteCarloResult(projectId);
  const runMc = useRunMonteCarlo(projectId);
  const [expanded, setExpanded] = useState(readExpanded);
  const [detailOpen, setDetailOpen] = useState(false);
  const isRecomputing = useForecastStaleness(mutationVersion, result, runMc.isPending);

  function toggle() {
    setExpanded((prev) => {
      const next = !prev;
      persistExpanded(next);
      return next;
    });
  }

  if (!result) {
    if (!projectId) return null;
    return (
      <ForecastEmptyState
        isLoading={isLoading}
        loadFailed={Boolean(error)}
        runMcIsError={runMc.isError}
        runMcIsPending={runMc.isPending}
        onRun={() => runMc.mutate({})}
        onRetry={() => refetch?.()}
      />
    );
  }

  // Server-computed P80 risk premium vs the CPM finish (issue 987). Gated on a known
  // CPM finish so the chip's "(+Nd)" suffix only appears when the deterministic
  // spine exists; the value itself is read from the server, not recomputed.
  const showDelta =
    Boolean(cpmFinish) && typeof result.deltaVsCpm.p80 === 'number' && result.deltaVsCpm.p80 > 0;

  const topDriver = result.sensitivity
    .map((s) => tasks.find((t) => t.id === s.taskId)?.name)
    .find((name): name is string => Boolean(name));

  const panelId = 'schedule-forecast-panel';

  const chips = buildForecastChips(result, showDelta);

  return (
    <>
      <section
        className="hidden md:block flex-shrink-0 border-t border-neutral-border bg-neutral-surface"
        aria-label="Schedule forecast"
      >
        {/* Collapsed header row — chips (once) + top driver + the three
            distinct affordances (toggle / Rerun / Details). */}
        <div className="flex w-full items-center gap-3 px-5 py-2.5">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={expanded}
            aria-controls={panelId}
            aria-label={expanded ? 'Minimize forecast detail' : 'Maximize forecast detail'}
            className="flex items-center gap-2 text-left text-sm font-semibold text-neutral-text-primary
              rounded-control hover:bg-neutral-surface-raised px-1 -mx-1
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary"
          >
            <span aria-hidden="true" className="text-xs text-neutral-text-secondary">
              {expanded ? '▾' : '▸'}
            </span>
            <span>Forecast</span>
          </button>

          {/* P50/P80/P95 chips — rendered ONCE (rule 189). P80 is the commit,
              accented; (+Nd) is the server-owned risk delta vs the CPM spine. */}
          <div className="flex items-center gap-1.5">
            {chips.map(({ label, iso, border, text, suffix }) => (
              <span
                key={label}
                className={`text-xs font-medium px-1.5 py-0.5 rounded-chip border ${border} ${text} bg-transparent whitespace-nowrap`}
              >
                {label}: {fmtUtcShort(iso)}
                {suffix}
              </span>
            ))}
          </div>

          {topDriver && (
            <span className="hidden truncate text-xs text-neutral-text-secondary lg:inline">
              top driver: {topDriver}
            </span>
          )}

          <div className="ml-auto flex items-center gap-2">
            {isRecomputing ? (
              <span
                data-testid="mc-recomputing"
                className="text-xs text-neutral-text-secondary tppm-mono whitespace-nowrap"
                aria-live="polite"
              >
                {runMc.isPending ? 'Recomputing…' : 'Stale — rerun for updated forecast'}
              </span>
            ) : (
              result.lastRunAt && (
                <span className="text-xs text-neutral-text-disabled tppm-mono whitespace-nowrap">
                  {formatRelative(new Date(result.lastRunAt))}
                </span>
              )
            )}
            <button
              type="button"
              onClick={() => runMc.mutate({})}
              disabled={runMc.isPending}
              aria-label="Rerun Monte Carlo forecast"
              title="Rerun Monte Carlo forecast"
              className={BTN_CLS}
            >
              {runMc.isPending ? 'Rerunning…' : 'Rerun'}
            </button>
            <button
              type="button"
              onClick={() => setDetailOpen(true)}
              data-testid="mc-details-btn"
              aria-label="Open Monte Carlo detail panel"
              className={BTN_CLS}
            >
              Details ›
            </button>
          </div>
        </div>

        {/* Expanded body — histogram + tornado + run-history disclosure. Motion
            uses only the shared empty-state-in keyframe (rule 177/186). */}
        {expanded && (
          <div id={panelId} className="motion-safe:animate-empty-state-in">
            <div className="grid grid-cols-1 gap-5 px-5 pb-4 pt-1 lg:grid-cols-2">
              {/* Finish-date forecast */}
              <div className="rounded-card border border-neutral-border p-4">
                <h3 className="text-sm font-semibold text-neutral-text-primary">
                  Finish-date forecast
                </h3>
                <p className="mb-3 text-xs text-neutral-text-secondary">
                  Monte Carlo · {result.runs.toLocaleString()} runs · P50–P80 band
                </p>
                <MonteCarloHistogram result={result} />
              </div>

              {/* What's holding the date — sensitivity tornado */}
              <div className="rounded-card border border-neutral-border p-4">
                <h3 className="text-sm font-semibold text-neutral-text-primary">
                  What&apos;s holding the date
                </h3>
                <p className="mb-3 text-xs text-neutral-text-secondary">
                  Sensitivity · tasks whose duration moves the finish most
                </p>
                <SensitivityList
                  sensitivity={result.sensitivity}
                  tasks={tasks}
                  forecastDiagnostic={result.forecastDiagnostic}
                />
              </div>
            </div>

            {/* Run-history disclosure — visible to all members; attribution
                gated server-side (ADR-0144). Collapsed by default on the bar. */}
            <ForecastHistorySection projectId={projectId} defaultExpanded={false} />
          </div>
        )}
      </section>

      <MonteCarloDetailPanel
        result={result}
        cpmFinish={cpmFinish ?? null}
        tasks={tasks}
        isOpen={detailOpen}
        onClose={() => setDetailOpen(false)}
      />
    </>
  );
}
