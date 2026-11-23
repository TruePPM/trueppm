import { Link } from 'react-router';
import type { Program } from '@/api/types';
import { QueryErrorState } from '@/components/QueryErrorState';
import { useProgramDecisions } from '@/features/programs/decisions/useProgramDecisions';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { programPath } from '@/lib/refPath';

const LIMIT = 3;

/**
 * Decisions awaiting an answer on this program (#4772's log, read-only here). The
 * order and the due dates are the server's; the card links to the full log. With
 * none waiting it says so rather than vanishing, so a quiet program reads as quiet.
 */
export function ProgramDecisionsCard({ program }: { program: Program }) {
  const { decisions, total, isLoading, error, refetch } = useProgramDecisions(
    program.id,
    'awaiting',
  );
  return (
    <section
      aria-labelledby="home-decisions"
      className="flex flex-col gap-2 rounded-lg border border-p1-hairline bg-p1-surface-1 p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="home-decisions" className="text-sm font-semibold text-p1-text-1">
          Needs a decision
        </h2>
        <Link
          to={programPath(program, 'decisions')}
          className="inline-flex min-h-[44px] items-center text-xs text-p1-brand underline focus:outline-none focus:ring-2 focus:ring-p1-focus"
        >
          All decisions
        </Link>
      </div>
      {error ? (
        <QueryErrorState
          variant="inline"
          message="Couldn't load decisions."
          onRetry={() => void refetch()}
        />
      ) : isLoading ? (
        <p role="status" className="text-sm text-p1-text-2">
          Loading decisions…
        </p>
      ) : total === 0 ? (
        <p className="text-sm text-p1-text-2">Nothing is waiting on a decision.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-p1-hairline">
          {decisions.slice(0, LIMIT).map((d) => (
            <li key={d.id} className="flex flex-col gap-0.5 py-2">
              <span className="text-sm text-p1-text-1">{d.title}</span>
              <span className="text-xs text-p1-text-2">
                {d.owner_detail ? `${d.owner_detail.display_name} · ` : ''}
                {d.due_date ? `decide by ${fmtUtcShort(d.due_date)}` : 'no due date'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
