import { useMemo, useState } from 'react';
import type { Task } from '@/types';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { useRunMonteCarlo } from '@/hooks/useRunMonteCarlo';
import { describeWriteRefusal, type WriteRefusal } from '@/lib/writeRefusal';
import { formatRelative } from '@/lib/formatRelative';
import { useForecastPresentation } from './useForecastPresentation';
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

/** What the bar is allowed to say and offer about this run's freshness. */
interface ForecastFreshness {
  /** Offer Rerun. True whenever the run is not confirmed current, or one is in flight. */
  offerRerun: boolean;
  /**
   * The notice to show in place of the `N ago` stamp, or `null` to keep the stamp.
   *
   * One string per thing the server can actually prove, which is why this is not a
   * boolean. `aged` keeps the original wording because the run really is out of date.
   * `projectChanged` gets a weaker sentence on purpose: the counter behind it moves on
   * ANY write in the project — a logged time entry, a label, a description — so "your
   * plan changed" would be an assertion the evidence does not reach. "Edited since this
   * run" is exactly what it does reach.
   *
   * Both strings are also length-constrained, and that is not cosmetic. This row is
   * over-full at 1280 and the notice sits inside the `shrink-0` control group, so a
   * longer sentence pushes the group past what `top driver`'s `truncate` can absorb
   * and shifts the Details button — the layout guarantee `e2e/schedule-monte-carlo`
   * pins with a boundingBox assertion. A first draft of this string was 51 characters
   * and moved Details 43px. Keep any new notice at or under the `aged` one.
   */
  notice: string | null;
}

/**
 * Read the server's staleness verdict — it does not compute one (#3140, web rule 359).
 *
 * This used to be a `useState(0)` counter bumped from `useScheduleCommit`'s drag/resize
 * commit, which made "is the forecast stale?" a fact about *this component instance's
 * lifetime* rather than about the data. It missed inline cell edits, add/delete row,
 * dependency changes, paste-many, bulk edit, three-point estimate edits (the actual Monte
 * Carlo inputs), and every collaborator write arriving over the WebSocket — and it reset
 * to zero on every reload and route re-entry. Tolerable while it only drove a *notice*;
 * a defect once #3132 gated the Rerun *action* on it, because the state a user most needs
 * the button in — a plan edited before this page was opened — was exactly the state that
 * read as "nothing to do".
 *
 * The verdict now rides the Monte Carlo payload (ADR-0599: the authoritative
 * classification of a server-computed outcome is itself server-computed), so it survives
 * a reload, covers every write path including a collaborator's, and needs no enumeration
 * of mutation sites here. `useProjectWebSocket` re-fetches the payload on the same events
 * that already invalidate tasks, so an in-session edit refreshes the verdict too.
 *
 * The action and the notice are decided separately, and that split is the point.
 * `unknown` — a run recorded before #3140 — means the answer is *unavailable*, not that
 * it is bad, so it earns the action but no notice at all. Asserting "Stale" there would
 * be the same species of unfounded claim this issue removed, pointing the other way.
 */
function useForecastStaleness(
  result: MonteCarloResult | undefined,
  runMcPending: boolean,
): ForecastFreshness {
  const staleness = result?.forecastStaleness ?? 'unknown';
  if (runMcPending) return { offerRerun: true, notice: 'Recomputing…' };
  return {
    offerRerun: staleness !== 'current',
    notice:
      staleness === 'aged'
        ? 'Stale — rerun for updated forecast'
        : staleness === 'projectChanged'
          ? 'Edited since this run'
          : null,
  };
}

interface ForecastEmptyStateProps {
  isLoading: boolean;
  loadFailed: boolean;
  /** The server's refusal from a failed run, shaped once (#3332). */
  runRefusal: WriteRefusal | null;
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
  runRefusal,
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
        className={`text-xs ${loadFailed || runRefusal ? 'text-semantic-critical' : 'text-neutral-text-secondary'}`}
        {...(loadFailed || runRefusal ? { role: 'alert' } : {})}
      >
        {isLoading
          ? 'Loading forecast…'
          : loadFailed
            ? "Couldn't load the forecast."
            : runRefusal
              ? // The server's own sentence, not "Could not run simulation. Try
                // again." — the desktop twin of `MobileMonteCarloCard` reads the
                // same `useRunMonteCarlo` hook and had the same defect (#3332).
                runRefusal.message
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
 * `localStorage['schedule.insightsExpanded']`), the Details action, and Rerun —
 * which is offered only on the stale branch (#3132), beside the sentence that
 * asks for it, rather than parked on every forecast row.
 * Expanded, it shows the histogram, the sensitivity tornado, and the run-history
 * disclosure. All forecast dates route through `lib/formatUtcDate`.
 */
export function ScheduleForecastBar({ projectId, tasks, cpmFinish }: Props) {
  const { data: result, isLoading, error, refetch } = useMonteCarloResult(projectId);
  const runMc = useRunMonteCarlo(projectId);
  // Same shaping as the mobile card — one definition, and "Run Monte Carlo"
  // keeps its verb on a refusal a replay cannot fix (web-rule 372a).
  const runRefusal = useMemo(
    () => describeWriteRefusal(runMc.error, "Couldn't run the simulation."),
    [runMc.error],
  );
  const [expanded, setExpanded] = useState(readExpanded);
  const [detailOpen, setDetailOpen] = useState(false);
  const { offerRerun, notice } = useForecastStaleness(result, runMc.isPending);
  const forecast = useForecastPresentation(result, cpmFinish);

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
        runRefusal={runRefusal}
        runMcIsPending={runMc.isPending}
        onRun={() => runMc.mutate({})}
        onRetry={() => refetch?.()}
      />
    );
  }

  const topDriver = result.sensitivity
    .map((s) => tasks.find((t) => t.id === s.taskId)?.name)
    .find((name): name is string => Boolean(name));

  const panelId = 'schedule-forecast-panel';

  return (
    <>
      {/* The height cap and the body scroller below are load-bearing, not
          tidiness (#3166). This bar is a `flex-shrink-0` child of ScheduleView's
          root `flex flex-col h-full overflow-hidden` column, so without a cap its
          expanded body simply grows: a twelve-run history measured 1685px inside
          a 640px column, which put 1114px of content past an ancestor that
          cannot scroll — unreachable by pointer, wheel and keyboard alike — and
          starved `ScheduleMainArea` until the Gantt canvas itself was zero
          pixels tall. The cap is `40vh` rather than half the column so the Gantt
          stays the larger surface at every viewport — this is a
          scheduling-first product and the forecast is a strip about the plan,
          not the plan — and nothing is lost to the smaller cap because the body
          below scrolls. `vh` rather than a percentage of the parent because a
          `%` max-height silently resolves to `none` if any link in the height
          chain stops being definite, which fails back to exactly this bug with
          no signal. `ReforecastPanel`, two strips up, already caps its own list
          this way; this bar and `ScheduleReconcileStrip` were the two that
          missed it. Pinned by `e2e/clipped-content.spec.ts`. */}
      <section
        className="hidden md:flex md:flex-col flex-shrink-0 max-h-[40vh] border-t border-neutral-border bg-neutral-surface"
        aria-label="Schedule forecast"
      >
        {/* Collapsed header row — chips (once) + top driver + the constant
            affordances (toggle / Details), plus Rerun on the stale branch
            only (#3132). Pinned: the percentiles must stay readable while the
            body below them scrolls. */}
        <div className="flex w-full shrink-0 items-center gap-3 px-5 py-2.5">
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

          {/* Chips — rendered ONCE (rule 189), and derived once by
              useForecastPresentation so this row can never contradict the
              histogram or the Overview tile about the same run (#2426). A
              degenerate run collapses to a single chip that names its own
              baseline; a real spread renders P50/P80/P95 plus a dashed CPM
              reference chip, so a delta never appears without the date it is
              measured from. */}
          <div className="flex items-center gap-1.5">
            {forecast.chips.map((chip) => (
              <span
                key={chip.key}
                className={`text-xs font-medium px-1.5 py-0.5 rounded-chip border ${chip.dashed ? 'border-dashed' : ''} ${chip.border} ${chip.textClass} bg-transparent whitespace-nowrap`}
              >
                {chip.text}
              </span>
            ))}
          </div>

          {topDriver && (
            <span className="hidden truncate text-xs text-neutral-text-secondary lg:inline">
              top driver: {topDriver}
            </span>
          )}

          {/* `shrink-0` is load-bearing, not tidiness (#3132). Without it this
              row is over-full at 1280 and the browser distributes the Rerun
              button's width across every shrinkable sibling — including the
              Details button, which lost 8px the moment the forecast went stale.
              Pinning the group's size moves that absorption onto `top driver`,
              which carries `truncate` for exactly this purpose, so no control
              changes size when the conditional button appears. */}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* The notice says only what the server can prove (#3140), and there
                is a branch with no notice at all: a run whose freshness the
                server CANNOT classify (`unknown` — recorded before #3140) keeps
                the ordinary `N ago` stamp. That branch is the point. It still
                offers Rerun below, because the action costs nothing when it turns
                out to be unnecessary — but it makes no staleness claim, because an
                unfounded "Stale" is this issue's own defect with the sign
                flipped. */}
            {notice !== null ? (
              <span
                data-testid="mc-recomputing"
                className="text-xs text-neutral-text-secondary tppm-mono whitespace-nowrap"
                aria-live="polite"
              >
                {notice}
              </span>
            ) : (
              result.lastRunAt && (
                <span className="text-xs text-neutral-text-disabled tppm-mono whitespace-nowrap">
                  {formatRelative(new Date(result.lastRunAt))}
                </span>
              )
            )}
            {/* Rerun is offered only when there is something to rerun FOR
                (#3132, UX-REVIEW §8.1). On a fresh forecast the bar already
                states when the server last confirmed the run, so a permanently
                parked recompute button is a debug affordance on a user surface.
                The stale branch immediately to the left is the sentence that
                asks for the action — the action belongs with it.

                Gated on `offerRerun` (= `runMc.isPending || staleness !== 'current'`),
                which includes the in-flight run, so the button survives its own
                recompute and disappears only when the server confirms the fresh
                result is current.

                The gate is now safe to read as "there is nothing to rerun for"
                (#3140). It was not before: `isStale` came from a session-local
                counter that only the drag/resize commit bumped, so an absent
                Rerun meant nothing about the plan. The predicate is a server fact
                that survives a reload, so an absent button is a claim the server
                made, not one this component inferred from its own lifetime.

                No layout shift either way: the row's height is set by the
                always-present Details button (both are `h-7`), the group is
                `ml-auto`-anchored to the right edge, and `shrink-0` (above)
                keeps the appearing button from stealing width from its
                siblings. Pinned by a boundingBox assertion in
                `e2e/schedule-monte-carlo.spec.ts`. */}
            {offerRerun && (
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
            )}
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
            uses only the shared empty-state-in keyframe (rule 177/186).
            `min-h-0` is what makes `overflow-y-auto` work at all: a flex item
            defaults to `min-height: auto` and so refuses to shrink below its
            content, which pushes the overflow up to the clipping ancestor
            instead of scrolling here (the same omission SettingsShell documents
            on its own two scrollers). */}
        {expanded && (
          <div
            id={panelId}
            className="min-h-0 flex-1 overflow-y-auto motion-safe:animate-empty-state-in"
          >
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
