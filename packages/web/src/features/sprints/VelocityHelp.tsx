import { FieldHelp } from '@/components/FieldHelp';

/**
 * Contextual help for the velocity panel (#3714): what the average counts, over
 * which sprints, and what the forecast range does and does not promise.
 */
export function VelocityHelp() {
  return (
    <FieldHelp
      label="Velocity"
      docHref="features/velocity/#what-you-see"
      docLabel="Reading velocity"
      body={
        <div className="flex flex-col gap-2">
          <p>
            Story points <strong>completed</strong> per sprint, averaged over the last closed
            sprints (up to eight), shown as <em>average ± standard deviation</em>.
          </p>
          <ul className="flex flex-col gap-1 text-xs text-neutral-text-secondary">
            <li>
              <strong className="text-neutral-text-primary">Closed sprints only.</strong> The
              sprint in progress is shown beside the history but is not in the average until it
              closes.
            </li>
            <li>
              <strong className="text-neutral-text-primary">Excluded sprints are held out</strong>{' '}
              of the average and the forecast, but stay visible, hatched, in the chart.
            </li>
            <li>
              <strong className="text-neutral-text-primary">The forecast range is the average ± one
              standard deviation.</strong> It is a range from past sprints, not a promise; a
              noisy history gives a wide band.
            </li>
            <li>
              Points are relative to this team, so compare a team with itself, not with another.
            </li>
          </ul>
        </div>
      }
    />
  );
}
