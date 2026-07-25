import type { ReactNode, Ref } from 'react';
import type { Task } from '@/types';
import { accentBarClass } from './cardFormat';

interface CardShellProps {
  task: Task;
  /** Callback ref that both measures the card and wires dnd-kit's node ref. */
  cardRef: Ref<HTMLDivElement>;
  /** dnd-kit listeners/attributes (or the read-only substitutes) plus focus tracking. */
  dragProps: Record<string, unknown>;
  containerClass: string;
  showCriticalState: boolean;
  effectiveProgress: number;
  columnLabel: string;
  isFilteredOut: boolean;
  /**
   * Compact density stops Enter/Space here so the window-level board keyboard
   * registry doesn't double-handle it (#2194); the taller densities do not.
   * Preserved as a flag rather than unified — the two branches have always
   * differed and changing it is a behavior change, not a refactor.
   */
  stopKeyPropagation: boolean;
  onCardClick?: (task: Task, anchor: HTMLElement) => void;
  children: ReactNode;
}

/**
 * The card root: focusable button semantics, the drag wiring, the left accent
 * bar, and the facet-filtered-out inert treatment. Shared by every rendered
 * density so the card's outer contract lives in exactly one place.
 */
export function CardShell({
  task,
  cardRef,
  dragProps,
  containerClass,
  showCriticalState,
  effectiveProgress,
  columnLabel,
  isFilteredOut,
  stopKeyPropagation,
  onCardClick,
  children,
}: CardShellProps) {
  return (
    <div
      ref={cardRef}
      {...dragProps}
      onClick={(e) => onCardClick?.(task, e.currentTarget)}
      onKeyDown={(e) => {
        if ((e.key !== 'Enter' && e.key !== ' ') || e.currentTarget !== e.target) return;
        // The focused card owns Enter/Space (open detail) — the cheatsheet's
        // "Enter — Open card detail" is real via this handler once j/k/l/h moves
        // DOM focus to the card (#2194).
        e.preventDefault();
        if (stopKeyPropagation) e.stopPropagation();
        onCardClick?.(task, e.currentTarget);
      }}
      className={containerClass}
      role="button"
      tabIndex={isFilteredOut ? -1 : 0}
      // `inert` (React 19 boolean prop) is the real fix (#2204): it removes a
      // facet-filtered-out card AND its inner buttons (··· menu, signal chips)
      // from the tab order — `aria-hidden` alone did NOT (aria-hidden hides
      // from AT but does not remove focusability, so keyboard focus still
      // landed on cards the user filtered away). `aria-hidden` is retained
      // because inert is not yet modeled by every a11y tree consumer.
      inert={isFilteredOut || undefined}
      aria-hidden={isFilteredOut || undefined}
      aria-label={`${task.name}, ${effectiveProgress}% complete${showCriticalState ? ', critical path' : ''}, in ${columnLabel}`}
    >
      {/* Left accent bar — rounded-l-card matches card's border-radius so the bar
          respects the card corners without needing overflow-hidden on the parent. */}
      <div
        className={`absolute left-0 inset-y-0 w-1 rounded-l-card ${accentBarClass(task, showCriticalState)}`}
        aria-hidden="true"
      />
      {children}
    </div>
  );
}
