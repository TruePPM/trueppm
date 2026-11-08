import { HeatCellBox, HeatLegend } from './HeatScale';
import { RiskZoneBand } from './RiskZoneBand';
import { SCurveChart, forecastToSCurveProps } from './SCurveChart';
import { StepBurnChart } from './StepBurnChart';
import { BURNDOWN, BURNDOWN_IDEAL, FORECAST, PROGRESS_SERIES } from './fixtures';

/**
 * Specimen sheet for the shared chart layer: every chart at its design sample
 * data, no network. Public and read-only so the screenshot specs and a reviewer
 * can see each chart in both themes without seeding a project.
 */
export function ChartSpecimenPage() {
  return (
    <main className="mx-auto flex max-w-[1100px] flex-col gap-6 bg-p1-surface-0 p-4 text-p1-text-1">
      <h1 className="m-0 text-xl font-semibold">Chart specimens</h1>
      <section
        aria-label="S-curve"
        data-testid="specimen-scurve"
        className="grid gap-4 md:grid-cols-2"
      >
        <SCurveChart
          title="Progress S-curve"
          definition="Cumulative percent complete: the planned line is the baseline schedule, the actual line is work reported done."
          series={PROGRESS_SERIES}
          band={{ from: FORECAST.p50, to: FORECAST.p80, label: 'P50 to P80 forecast band' }}
          markers={[
            { key: 'p50', date: FORECAST.p50, label: 'P50', tone: 'ok', dash: 'solid' },
            { key: 'p80', date: FORECAST.p80, label: 'P80', tone: 'risk', dash: 'dashed' },
          ]}
          today="2026-05-25"
        />
        <SCurveChart {...forecastToSCurveProps(FORECAST, '2026-05-25')} />
      </section>
      <section aria-label="Burndown" data-testid="specimen-burn">
        <StepBurnChart
          title="Sprint burndown"
          definition="Story points not yet done, as recorded each day. The line steps because the value only changes when work is reported."
          observed={BURNDOWN}
          ideal={BURNDOWN_IDEAL}
          markers={[{ key: 'mid', date: '2026-05-11', label: 'Mid-sprint review' }]}
        />
      </section>
      <section aria-label="Risk zones" data-testid="specimen-zones">
        <RiskZoneBand
          title="Schedule risk zones"
          definition="How far the P80 finish sits from the commitment: on track, watch, or at risk."
          unit="d"
          zones={[
            { key: 'ok', label: 'On track', from: -10, to: 0, tone: 'ok' },
            { key: 'watch', label: 'Watch', from: 0, to: 5, tone: 'risk' },
            { key: 'risk', label: 'At risk', from: 5, to: 15, tone: 'critical' },
          ]}
          markers={[
            { key: 'p50', at: 1, label: 'P50' },
            { key: 'p80', at: 2, label: 'P80' },
            { key: 'p95', at: 6, label: 'P95' },
          ]}
        />
      </section>
      <section
        aria-label="Heat palette"
        data-testid="specimen-heat"
        className="flex flex-col gap-2"
      >
        <h2 className="m-0 text-sm font-semibold">Load heat palette</h2>
        <HeatLegend />
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
          {[0, 15, 35, 55, 75, 95, 105, 130].map((p) => (
            <HeatCellBox key={p} loadPct={p} label={`Week ${p}`} />
          ))}
        </div>
      </section>
    </main>
  );
}
