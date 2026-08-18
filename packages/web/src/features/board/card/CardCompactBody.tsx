import type { Task } from '@/types';
import { MoreHorizontalIcon } from '@/components/Icons';
import { LabelPillRow } from '@/components/LabelPill';
import type { ProjectCustomField } from '@/hooks/useProjectCustomFields';
import { useIsCoarsePointer } from '@/hooks/useIsCoarsePointer';
import { useIsOverflowing } from '@/hooks/useIsOverflowing';
import { useElementRef } from '@/hooks/useElementRef';
import { PendingAcceptanceChip } from '../PendingAcceptanceChip';
import { PendingSyncBadge } from '../PendingSyncBadge';
import { CardPeekButton } from '../CardPeekButton';
import { CustomFieldCompactPeek } from '../CustomFieldMarks';
import { cardSignalToneClass } from '../cardSignal';
import { CardSignalChips } from './CardSignalChips';
import { cardTitleToneClass, cpTooltip } from './cardFormat';
import type { BoardCardView } from './useBoardCardView';
import { useLaneCrumb } from '../LaneCrumbContext';

/** Progress-strip fill: red on a critical card, green at 100%, brand otherwise. */
function progressColorClass(showCriticalState: boolean, effectiveProgress: number): string {
  if (showCriticalState) return 'bg-semantic-critical';
  if (effectiveProgress === 100) return 'bg-semantic-on-track';
  return 'bg-brand-primary';
}

/**
 * Worst-offender badge on the compact bar (issue #1925) — glyph-only: the single
 * highest-severity glyph + tone is enough to scan by, and its word lives in
 * srText. It subsumes the old CP chip (critical path is one of its tiers), so
 * the red accent bar + name color still mark a CP card even when a higher signal
 * (blocked/stale) wins the badge.
 *
 * On a coarse pointer (#1947, web-rule 256) the glyph's meaning is otherwise
 * trapped in `title`/`aria-label` — unreachable on touch — so the badge promotes
 * to a tap-to-peek `CardPeekButton` revealing the full `srText` sentence. The
 * trigger keeps its semantic tone; the peek surface stays neutral (rule 253a).
 * Closed state is portaled → zero added layout, so the 36px compact bar height is
 * unchanged. Fine pointer: today's exact display-only `<span>`.
 */
function CompactSignalBadge({
  cardSignal,
  coarsePointer,
}: {
  cardSignal: NonNullable<BoardCardView['cardSignal']>;
  coarsePointer: boolean;
}) {
  const toneClass = cardSignalToneClass(cardSignal.tone);
  // Capitalized binding so JSX resolves it as a component, not an element.
  const { Icon: SignalIcon } = cardSignal;
  if (coarsePointer) {
    return (
      <CardPeekButton
        ariaLabel={`${cardSignal.label}. What does this mean?`}
        peekAriaLabel={`${cardSignal.label} — explanation`}
        triggerClassName={`shrink-0 px-1 py-px rounded-chip text-xs border font-medium ${toneClass}`}
        triggerContent={
          <SignalIcon aria-hidden="true" className="h-3 w-3" data-testid="card-signal-icon" />
        }
      >
        {cardSignal.srText}
      </CardPeekButton>
    );
  }
  return (
    <span
      className={`shrink-0 inline-flex items-center px-1 py-px rounded-chip text-xs border font-medium ${toneClass}`}
      title={cardSignal.srText}
      aria-label={cardSignal.srText}
    >
      <SignalIcon aria-hidden="true" className="h-3 w-3" data-testid="card-signal-icon" />
    </span>
  );
}

interface CardCompactBodyProps {
  task: Task;
  view: BoardCardView;
  customFieldDefs?: ProjectCustomField[];
  onShowDeps?: (task: Task) => void;
  onShowRisks?: (task: Task) => void;
  onChainHoverEnter: () => void;
  onChainHoverLeave: () => void;
}

/**
 * Compact density — title + signal glyph + progress strip, ~36px (issue 193).
 *
 * The coarse-pointer hooks live here (rather than in `BoardCard`) because the
 * compact bar is their only consumer; on a fine pointer `coarsePointer` is false
 * and this renders the desktop DOM unchanged.
 */
export function CardCompactBody({
  task,
  view,
  customFieldDefs,
  onShowDeps,
  onShowRisks,
  onChainHoverEnter,
  onChainHoverLeave,
}: CardCompactBodyProps) {
  // Compact-bar touch affordances (#1947, web-rule 256). On a coarse pointer the
  // compact card's hover-only health badge and truncated title have no reachable
  // channel, so each promotes to a tap-to-peek `CardPeekButton`.
  const coarsePointer = useIsCoarsePointer();
  const { el: titleEl, setEl: setTitleEl } = useElementRef<HTMLSpanElement>();
  const titleOverflowing = useIsOverflowing(titleEl);

  // The nested phase this card sits in (#2947). It renders here as well as on
  // the full card because mobile pins compact density — and under the case 16
  // rule the crumb is the *only* carrier of that fact, now that a nested phase
  // is no longer a lane of its own. Omitting it here would leave the phone with
  // strictly less information than before the rule landed.
  const laneCrumb = useLaneCrumb(task.id);

  return (
    <>
      <div className="pl-2.5 pr-8 py-2 flex items-center gap-1 min-w-0">
        {laneCrumb && (
          <span
            className="text-xs text-neutral-text-secondary shrink min-w-0 max-w-[40%] truncate"
            title={`In ${laneCrumb}`}
          >
            {laneCrumb} <span aria-hidden="true">&#9656;</span>
          </span>
        )}
        <span
          ref={setTitleEl}
          className={[
            'text-xs font-medium truncate flex-1 min-w-0',
            cardTitleToneClass(view.showCriticalState, view.isIdea),
          ].join(' ')}
          title={view.showCriticalState ? cpTooltip(task) : task.name}
        >
          {task.name}
        </span>
        {/* Title disclosure (#1947, web-rule 256). The truncated title silently
            drops its tail on touch, where `title=` never surfaces. On a coarse
            pointer AND when the title actually overflows, render a dedicated
            end-of-title glyph button that peeks the full name; when it fits,
            render nothing (rule 122). The card body stays the task-open target
            — the title text itself is never the trigger. */}
        {coarsePointer && titleOverflowing && (
          <CardPeekButton
            ariaLabel={`Show full title: ${task.name}`}
            peekAriaLabel="Full task title"
            triggerContent={
              <MoreHorizontalIcon
                className="h-3.5 w-3.5 text-neutral-text-secondary"
                aria-hidden="true"
              />
            }
          >
            {task.name}
          </CardPeekButton>
        )}
        {view.isPending && (
          <PendingAcceptanceChip compact explainer={view.pendingExplainer} className="shrink-0" />
        )}
        {view.isPendingSync && <PendingSyncBadge compact className="shrink-0" />}
        {view.cardSignal && (
          <CompactSignalBadge cardSignal={view.cardSignal} coarsePointer={coarsePointer} />
        )}
        {/* Dependency / risk signal chips in-flow (issue 1735). Suppressed on a
            pending card, which shows the accept ✓ instead. */}
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
        {/* Labels (ADR-0400): color dots only at compact density. */}
        {(task.labels?.length ?? 0) > 0 && (
          <span className="shrink-0">
            <LabelPillRow labels={task.labels ?? []} density="compact" />
          </span>
        )}
        {/* Custom fields (#2144): 0 inline on the 36px bar — one trailing ⊕N peek. */}
        {customFieldDefs && customFieldDefs.length > 0 && (
          <CustomFieldCompactPeek fields={customFieldDefs} values={task.customFields} />
        )}
      </div>
      {/* 3px progress strip at the bottom of each compact card */}
      <div
        className="absolute bottom-0 left-1 right-1 h-[3px] rounded-full overflow-hidden bg-neutral-border"
        aria-hidden="true"
      >
        <div
          className={`h-full ${progressColorClass(view.showCriticalState, view.effectiveProgress)}`}
          style={{ width: `${view.effectiveProgress}%` }}
        />
      </div>
    </>
  );
}
