import { FieldHelp } from '@/components/FieldHelp';

/**
 * Contextual help for the two slack columns (#3714). "Float" and "Free" are
 * two different numbers sharing one word, and the hover tooltip on the column
 * header is one sentence each — it cannot say whose slack is whose, or what a
 * negative value means. Copy lives here once so the Grid header and the task
 * drawer's Float cell cannot drift into two readings of the same term.
 */
export function FloatHelp() {
  return (
    <FieldHelp
      label="Total float and free float"
      docHref="features/schedule/#float-and-free-float"
      docLabel="Float and free float"
      body={
        <div className="flex flex-col gap-2">
          <p>
            Both count <strong>working days</strong> a task can slip. They differ in whose deadline
            moves first.
          </p>
          <ul className="flex flex-col gap-1 text-xs text-neutral-text-secondary">
            <li>
              <strong className="text-neutral-text-primary">Total float</strong> — slip before the{' '}
              <em>project finish</em> moves. Zero means the task is on the critical path.
            </li>
            <li>
              <strong className="text-neutral-text-primary">Free float</strong> — slip before the{' '}
              <em>next task</em> has to move. Never larger than total float.
            </li>
          </ul>
          <p>
            A task with 8d total and 2d free has room in the plan, but spending more than 2 days
            pushes someone else&apos;s start. Total float is shared along a chain, so two tasks in a
            row cannot both use all of theirs.
          </p>
          <p className="text-xs text-neutral-text-secondary">
            A negative value means the task is already late against the project finish. A dash means
            the schedule has not been calculated for this row yet, which is not the same as zero.
          </p>
        </div>
      }
    />
  );
}
