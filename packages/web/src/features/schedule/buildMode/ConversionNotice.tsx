import { useEffect, useState } from 'react';
import { CloseIcon } from '@/components/Icons';
import type { Task } from '@/types';

/** Rows already told about; module-scoped so it survives a row unmount/remount. */
const announced = new Set<string>();

/** Test seam — a suite must not inherit another suite's "already told you". */
export function __resetConversionNotices(): void {
  announced.clear();
}

interface Props {
  tasks: readonly Task[];
}

/**
 * "This became a phase, and here is what happened to your numbers" (#2951).
 *
 * The transition is otherwise invisible and lossy-looking: a row you owned the
 * estimate of starts showing a rolled-up number, and nothing says the value you
 * typed still exists. It does — `own_estimate` parks it (ADR-0844) — but a user
 * has no way to know that from the screen.
 *
 * **Once per row, not once per project.** A planner building a twenty-phase WBS
 * does not need the same sentence twenty times; a planner whose single task just
 * changed identity under them needs it once, clearly.
 *
 * Detection is by `auto_container`: the server sets it only when a row became a
 * container by *gaining a child* rather than by declaration. A phase somebody
 * created on purpose never needed explaining.
 */
export function ConversionNotice({ tasks }: Props) {
  const [showing, setShowing] = useState<Task | null>(null);

  useEffect(() => {
    const fresh = tasks.find((t) => t.autoContainer && !announced.has(t.id));
    if (!fresh) return;
    announced.add(fresh.id);
    setShowing(fresh);
  }, [tasks]);

  if (!showing) return null;

  const estimate = showing.ownEstimate;

  return (
    <div
      role="status"
      className="flex items-start gap-2 px-4 py-2 border-b border-neutral-border
        bg-neutral-surface-sunken text-xs text-neutral-text-secondary flex-shrink-0"
    >
      <span className="flex-1">
        <b className="font-medium text-neutral-text-primary">{showing.name || 'Untitled'}</b>{' '}
        became a phase. Its status
        {estimate != null && (
          <>
            {' '}
            and its own <span className="tppm-mono">{estimate}d</span> estimate
          </>
        )}{' '}
        now roll up from the work inside — {/* the reassurance is the point */}
        <b className="font-medium text-neutral-text-primary">the values are kept, not cleared</b>,
        and come back if it loses its last task.
      </span>
      <button
        type="button"
        onClick={() => setShowing(null)}
        aria-label="Dismiss"
        className="shrink-0 text-neutral-text-secondary hover:text-neutral-text-primary
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 rounded-control"
      >
        <CloseIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
