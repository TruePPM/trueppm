import type { RefObject } from 'react';
import type { Task } from '@/types';
import { LabelPillRow } from '@/components/LabelPill';
import { PendingAcceptanceChip } from '../PendingAcceptanceChip';
import { PendingSyncBadge } from '../PendingSyncBadge';
import { cardSignalToneClass } from '../cardSignal';
import { CardAssignees } from './CardAssignees';
import { CardSignalChips } from './CardSignalChips';
import type { BoardCardView } from './useBoardCardView';

interface CardBadgeRowProps {
  task: Task;
  view: BoardCardView;
  overallocByResource?: Map<string, number>;
  peekOpen: boolean;
  onTogglePeek: () => void;
  signalBadgeRef: RefObject<HTMLButtonElement | null>;
  onShowDeps?: (task: Task) => void;
  onShowRisks?: (task: Task) => void;
  onChainHoverEnter: () => void;
  onChainHoverLeave: () => void;
}

/**
 * Whether the badge row has anything to say. Kept as a predicate so the row
 * disappears entirely (rule 122) rather than reserving empty vertical space.
 */
export function hasBadgeRowContent(view: BoardCardView, task: Task): boolean {
  return (
    (view.cardSignal !== null && !view.isDetailed) ||
    view.showCriticalState ||
    view.isPending ||
    view.isPendingSync ||
    (!view.isPending && (view.showChain || view.showRisk)) ||
    task.assignees.length > 0 ||
    (task.labels?.length ?? 0) > 0 ||
    view.isIdea
  );
}

/**
 * Badge row — worst-offender badge (or CP at detailed), pending chip,
 * dependency/risk signal chips, labels, assignees.
 *
 * Comfortable density renders one interactive worst-offender badge that toggles
 * the health-chip peek (issue 1305). Detailed keeps the CP chip inline since the
 * full chip set is already shown below — no badge, no peek.
 */
export function CardBadgeRow({
  task,
  view,
  overallocByResource,
  peekOpen,
  onTogglePeek,
  signalBadgeRef,
  onShowDeps,
  onShowRisks,
  onChainHoverEnter,
  onChainHoverLeave,
}: CardBadgeRowProps) {
  if (!hasBadgeRowContent(view, task)) return null;
  const { cardSignal } = view;
  return (
    <div className="flex items-center gap-1 mt-1.5 flex-wrap">
      {view.isPending && <PendingAcceptanceChip explainer={view.pendingExplainer} />}
      {view.isPendingSync && <PendingSyncBadge />}
      {!view.isDetailed && cardSignal ? (
        <button
          ref={signalBadgeRef}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTogglePeek();
          }}
          aria-expanded={peekOpen}
          aria-controls={view.peekId}
          aria-label={`${cardSignal.srText}. Show health details.`}
          className={`relative inline-flex items-center gap-0.5 px-1.5 py-px rounded-chip text-xs border font-medium
                  before:absolute before:inset-[-12px] before:content-['']
                  focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
                  ${cardSignalToneClass(cardSignal.tone)}`}
        >
          <span aria-hidden="true">{cardSignal.glyph}</span>
          <span>{cardSignal.label}</span>
        </button>
      ) : (
        view.showCriticalState && (
          <span
            className="inline-block px-1 py-px rounded-chip text-xs text-white bg-semantic-critical font-bold"
            aria-hidden="true"
          >
            CP
          </span>
        )
      )}
      {/* Dependency / risk signal chips in-flow (issue 1735). Suppressed on
          a pending card, which shows the accept ✓ instead. */}
      {!view.isPending && (
        <CardSignalChips
          task={task}
          showChain={view.showChain}
          showRisk={view.showRisk}
          isBlocked={view.isBlocked}
          predecessorCount={view.predecessorCount}
          linkedRisksCount={view.linkedRisksCount}
          linkedRisksMaxSeverity={view.linkedRisksMaxSeverity}
          onShowDeps={onShowDeps}
          onShowRisks={onShowRisks}
          onChainHoverEnter={onChainHoverEnter}
          onChainHoverLeave={onChainHoverLeave}
        />
      )}
      {/* Labels (ADR-0400): 2 pills + overflow at comfortable, all at detailed. */}
      <LabelPillRow
        labels={task.labels ?? []}
        density={view.isDetailed ? 'detailed' : 'comfortable'}
      />
      <CardAssignees
        task={task}
        isIdea={view.isIdea}
        isDetailed={view.isDetailed}
        overallocByResource={overallocByResource}
      />
    </div>
  );
}
