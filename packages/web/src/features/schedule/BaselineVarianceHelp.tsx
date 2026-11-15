import { FieldHelp } from '@/components/FieldHelp';

/**
 * Contextual help for the baseline variance chip (#3714). The chip says "+3d"
 * and nothing about what it is measured against, so a PM cannot tell whether a
 * baseline from three months ago or last week produced it.
 */
export function BaselineVarianceHelp() {
  return (
    <FieldHelp
      label="Baseline variance"
      docHref="features/baselines/#comparing-against-the-plan"
      docLabel="Comparing against the plan"
      body={
        <div className="flex flex-col gap-2">
          <p>
            How far this task&apos;s <strong>current finish</strong> sits from its finish in the{' '}
            <strong>active baseline</strong>, in working days. Positive is late; negative is early.
          </p>
          <ul className="flex flex-col gap-1 text-xs text-neutral-text-secondary">
            <li>
              The comparison is always against the one baseline marked active. Activate a
              different baseline and every chip re-reads against it.
            </li>
            <li>
              The current finish is the CPM date, which assumes every task takes exactly its
              estimate. It is not a Monte Carlo percentile, so a task can show 0d here and still
              be a coin flip to hit.
            </li>
            <li>No baseline on a task reads &quot;No baseline&quot;, not zero.</li>
          </ul>
        </div>
      }
    />
  );
}
