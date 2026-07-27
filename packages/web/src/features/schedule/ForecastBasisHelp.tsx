import { FieldHelp } from '@/components/FieldHelp';

/**
 * Contextual-help affordance explaining what the schedule's two kinds of finish
 * date actually are: the deterministic CPM finish the Gantt bars carry, versus
 * the probability distribution a Monte Carlo run produces around it.
 *
 * Why this exists (#2439): the app showed hard dates everywhere — bars, the
 * Finish column, the Overview forecast KPI — and the only place it acknowledged
 * that the CPM date is a single optimistic point was an unexplained
 * "deterministic finish" heading inside this panel. A PM reading a Gantt bar has
 * no way to learn that committing to it is close to a coin flip.
 *
 * Deliberately its own component rather than an inline `<FieldHelp body=…>`: the
 * same explanation belongs on the collapsed forecast bar too, and that surface
 * is mid-refactor under #2426. Keeping the copy in one place means the second
 * mount point is an import, not a paste — the two can never drift into saying
 * different things about the same number.
 */
export function ForecastBasisHelp() {
  return (
    <FieldHelp
      label="How to read these dates"
      docHref="features/monte-carlo/#interpreting-results"
      docLabel="Interpreting the forecast"
      body={
        <div className="flex flex-col gap-2">
          <p>
            The dates on the timeline come from the <strong>CPM schedule</strong> — the earliest
            everything can finish if every task takes exactly as long as estimated and nothing
            slips. It is one date, and an optimistic one.
          </p>
          <p>
            A Monte Carlo run re-plays the schedule thousands of times with the durations varying,
            which gives the odds behind that date:
          </p>
          <ul className="flex flex-col gap-1 text-xs text-neutral-text-secondary">
            <li>
              <strong className="text-neutral-text-primary">P50</strong> — half of runs finished by
              here. Usually close to the CPM date, so it is a midpoint, not a promise.
            </li>
            <li>
              <strong className="text-neutral-text-primary">P80</strong> — 4 in 5 runs finished by
              here. This is the date to commit to.
            </li>
            <li>
              <strong className="text-neutral-text-primary">P95</strong> — 19 in 20 runs finished by
              here. For contractual or external deadlines.
            </li>
          </ul>
          <p className="text-xs text-neutral-text-secondary">
            A P80 later than the CPM finish is not a disagreement between the two — it is the
            schedule risk the CPM pass cannot express.
          </p>
        </div>
      }
    />
  );
}
