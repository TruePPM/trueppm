import type { Task } from '@/types';
import type { BoardCardScopeActions } from './types';

interface CardAcceptIconProps {
  task: Task;
  isPending: boolean;
  scopeActions?: BoardCardScopeActions;
  /** Iteration vocabulary ("sprint" / "iteration") for the accept copy. */
  iterationLabel: string;
}

/**
 * Single-tap accept ✓ for a pending scope injection (ADR-0102 §5). Additive
 * action → no confirm (frontend rule 150). Sits left of the ··· menu. Gated
 * by canManage; hidden offline (rule 152). Reject is in the overflow menu.
 */
export function CardAcceptIcon({
  task,
  isPending,
  scopeActions,
  iterationLabel,
}: CardAcceptIconProps) {
  if (!isPending || !scopeActions?.canManage || scopeActions.offline) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        scopeActions.onAccept(task);
      }}
      aria-label={`Accept ${task.name} into the ${iterationLabel}`}
      title={`Accept into the ${iterationLabel}`}
      className="absolute top-2 right-9 w-6 h-6 flex items-center justify-center rounded-control
          text-brand-primary hover:bg-brand-primary/10
          before:absolute before:inset-[-10px] before:content-['']
          focus:opacity-100 focus:ring-2 focus:ring-brand-primary
          focus:ring-offset-1 focus:outline-none"
    >
      <span aria-hidden="true">✓</span>
    </button>
  );
}
