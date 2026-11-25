import { Link } from 'react-router';

import { QueryErrorState } from '@/components/QueryErrorState';
import {
  useBaselines,
  useBaselineVariance,
  type ApiBaselineVarianceSummary,
} from '@/hooks/useBaselines';
import { fmtUtcMedium } from '@/lib/formatUtcDate';

/**
 * "What moved" against the active baseline, on the project Overview.
 *
 * Every number here is the server's `summary` from the baseline variance read
 * (ADR-1485 D3): nothing is summed client-side, because the server leaves summary
 * tasks out so a slip is counted once, and a client adding up rows would count it
 * twice. The rows themselves are not listed — the panel answers "how far did we
 * move and what drove it", and the per-task deltas stay in the Schedule.
 *
 * Direction is carried by words ("later" / "earlier"), never by color alone
 * (rule 120), and every count of days names its unit (rule 445). No health hue:
 * drift is a measurement, and the Overview's health band already owns the verdict.
 */
export function BaselineDriftSummary({ projectId }: { projectId: string }) {
  const baselines = useBaselines(projectId);
  const active = baselines.data?.find((b) => b.is_active) ?? null;
  const variance = useBaselineVariance(projectId, active?.id);

  return (
    <section
      aria-labelledby="baseline-drift-heading"
      className="flex flex-col gap-3 p-5 rounded-card border border-neutral-border bg-neutral-surface-raised"
      data-testid="baseline-drift-summary"
    >
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2
          id="baseline-drift-heading"
          className="text-sm font-semibold text-neutral-text-secondary uppercase tracking-wide"
        >
          Baseline drift
        </h2>
        {variance.data && (
          <span
            className="text-xs text-neutral-text-secondary truncate max-w-full"
            title={variance.data.baseline_name}
          >
            vs {variance.data.baseline_name}
          </span>
        )}
      </div>
      <DriftBody
        projectId={projectId}
        baselinesLoading={baselines.isLoading}
        baselinesError={baselines.isError}
        hasActive={active !== null}
        varianceLoading={variance.isLoading}
        varianceError={variance.isError}
        summary={variance.data?.summary}
        hasCpmDates={variance.data?.has_cpm_dates ?? true}
        retry={() => {
          void (baselines.isError ? baselines.refetch() : variance.refetch());
        }}
      />
    </section>
  );
}

interface DriftBodyProps {
  projectId: string;
  baselinesLoading: boolean;
  baselinesError: boolean;
  hasActive: boolean;
  varianceLoading: boolean;
  varianceError: boolean;
  summary: ApiBaselineVarianceSummary | undefined;
  hasCpmDates: boolean;
  retry: () => void;
}

const PRE_CPM_COPY =
  "This baseline was captured before the schedule was first calculated, so it can't be compared with the current plan.";
const NOT_COMPARABLE_COPY =
  "The baseline can't be compared with the current plan yet: no task has dates on both sides.";

function DriftBody(props: DriftBodyProps) {
  const { projectId, summary } = props;
  if (props.baselinesError || props.varianceError) {
    return (
      <QueryErrorState
        variant="inline"
        message="Couldn't load the baseline drift."
        onRetry={props.retry}
      />
    );
  }
  if (props.baselinesLoading || (props.hasActive && props.varianceLoading)) {
    return (
      <div data-testid="baseline-drift-skeleton" className="flex flex-col gap-2" aria-hidden="true">
        <div className="h-5 w-2/3 rounded bg-neutral-surface motion-safe:animate-pulse" />
        <div className="h-4 w-1/2 rounded bg-neutral-surface motion-safe:animate-pulse" />
        <div className="h-4 w-3/5 rounded bg-neutral-surface motion-safe:animate-pulse" />
      </div>
    );
  }
  if (!props.hasActive || !summary) {
    return (
      <p className="text-sm text-neutral-text-secondary">
        No active baseline, so there is nothing to compare against.{' '}
        <Link
          to={`/projects/${projectId}/schedule`}
          className="text-brand-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-primary rounded-sm"
        >
          Set one in the Schedule
        </Link>
      </p>
    );
  }
  // A pre-CPM snapshot has no real dates, and a rollup with nothing comparable is
  // not "nothing moved": both say so rather than reporting a reassuring zero.
  if (!props.hasCpmDates) {
    return <p className="text-sm text-neutral-text-primary">{PRE_CPM_COPY}</p>;
  }
  if (summary.tasks_moved === 0 && summary.project_finish.delta_working_days === null) {
    return <p className="text-sm text-neutral-text-primary">{NOT_COMPARABLE_COPY}</p>;
  }
  if (summary.tasks_moved === 0) {
    return (
      <p className="text-sm text-neutral-text-primary">
        No task has moved since the baseline. {finishSentence(summary)}
      </p>
    );
  }
  const top = summary.top_slip;
  return (
    <ul className="flex flex-col gap-1.5 text-sm text-neutral-text-primary">
      <li className="font-medium">{finishSentence(summary)}</li>
      {/* Not a partition: a task whose start alone moved is in the moved count only. */}
      <li>
        {plural(summary.tasks_moved, 'task')} moved ({summary.tasks_finishing_later} finish later,{' '}
        {summary.tasks_finishing_earlier} finish earlier).
      </li>
      {summary.finish_slip_working_days_total > 0 && (
        <li>{days(summary.finish_slip_working_days_total)} of finish slip in total.</li>
      )}
      {top && (
        <li className="min-w-0">
          Largest slip:{' '}
          <Link
            to={`/projects/${projectId}/tasks/${top.task_id}`}
            className="text-brand-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-primary rounded-sm"
          >
            {top.task_name}
          </Link>
          , {days(top.finish_delta_working_days)} later.
          {top.cause && <span className="text-neutral-text-secondary"> {top.cause}</span>}
        </li>
      )}
    </ul>
  );
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function days(n: number): string {
  return plural(Math.abs(n), 'working day');
}

/** The project-finish shift, in words; never a bare signed number. */
function finishSentence(summary: ApiBaselineVarianceSummary): string {
  const { baseline_finish, current_finish, delta_working_days } = summary.project_finish;
  if (delta_working_days === null || !current_finish) {
    return 'The project finish cannot be compared yet.';
  }
  const now = fmtUtcMedium(current_finish);
  if (delta_working_days === 0) return `Project finish ${now}, on the baseline.`;
  const direction = delta_working_days > 0 ? 'later' : 'earlier';
  return `Project finish ${now}, ${days(delta_working_days)} ${direction} than the baseline (${fmtUtcMedium(baseline_finish)}).`;
}
