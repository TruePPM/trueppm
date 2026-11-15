import { FieldHelp } from '@/components/FieldHelp';

/**
 * Contextual help for utilization percentages (#3714). The number is
 * unreadable without two facts: where the load comes from, and which dates it
 * is measured over.
 */
export function UtilizationHelp() {
  return (
    <FieldHelp
      label="Utilization"
      docHref="features/resources/#team-utilization-on-the-project-overview"
      docLabel="How utilization is computed"
      body={
        <div className="flex flex-col gap-2">
          <p>
            Allocated hours as a percentage of the person&apos;s working capacity for the period.
            Over 100% means more work is assigned than the calendar has room for.
          </p>
          <ul className="flex flex-col gap-1 text-xs text-neutral-text-secondary">
            <li>
              <strong className="text-neutral-text-primary">Load comes from resource assignments</strong>{' '}
              (the units on a task). A person named only as a task&apos;s owner, with no
              resource assignment, adds nothing here.
            </li>
            <li>
              <strong className="text-neutral-text-primary">A task counts over its full span</strong>,
              not just its remaining work, so reporting progress does not make a person look free.
            </li>
            <li>
              Capacity follows the resource&apos;s own calendar, then the project&apos;s. Leave and
              holidays lower it, which raises the percentage.
            </li>
          </ul>
        </div>
      }
    />
  );
}
