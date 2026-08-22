import type { Task } from '@/types';
import type { EstimationScale } from '@/api/types';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { isTaskScheduled } from '@/lib/task';
import { pendingAcceptanceExplainer } from '../PendingAcceptanceChip';
import { useIsCardPendingSync } from '../offline/boardOutboxStore';
import { classifyCardSignal, type CardSignal } from '../cardSignal';
import { entryStamp } from './cardFormat';
import type { BoardCardColumn, BoardCardProps, BoardDensity, EvmMode } from './types';

/** Column context the card needs: sibling columns for "Move to…", its own label + SLA. */
interface ColumnContext {
  otherColumns: BoardCardColumn[];
  columnLabel: string;
  slaDays: number | undefined;
}

/**
 * A screen-reader user tabbing card-to-card cannot tell which column/status a
 * card sits in — the column cells are plain <div>s with no programmatic
 * context (#2204). Resolve this card's column label so the status can travel
 * with focus in the card's accessible name. Falls back to the raw status key
 * when the column has no configured label.
 */
function deriveColumnContext(columns: BoardCardColumn[], task: Task): ColumnContext {
  const sameStatus = columns.filter((c) => c.status === task.status);
  // With named lanes (#2967) a status maps to several tracks, so "the card's
  // column" is the track it renders in — not the first one that shares its
  // status, which would announce every QA card as sitting in Peer review. An
  // unset or deleted lane key falls to the first track, exactly as
  // `resolveTrackKey` places the card.
  const own =
    sameStatus.find((c) => (c.laneKey ?? null) === (task.boardLane || null)) ?? sameStatus[0];
  // "Move to…" is a STATUS menu, and stays one under named lanes (#2967): the
  // list it is built from now carries one entry per rendered track, so a column
  // with three lanes would otherwise offer the same status three times.
  // `onMenuMove` takes a status, so the extra entries would be indistinguishable
  // duplicates rather than lane targets — deduplicate to the first per status.
  const seen = new Set<Task['status']>([task.status]);
  const otherColumns = columns.filter((c) => {
    if (seen.has(c.status)) return false;
    seen.add(c.status);
    return true;
  });
  // A lane label alone ("QA") is not a location; prefix the column so the card's
  // accessible name still says which status it is in.
  const label = own?.columnLabel && own.laneKey ? `${own.columnLabel} · ${own.label}` : own?.label;
  return {
    otherColumns,
    columnLabel: label ?? task.status,
    slaDays: own?.slaDays,
  };
}

/** Dwell/aging facts: the entry stamp, the stalled verdict, and the SLA breach tiers. */
interface DwellFacts {
  stampText: string;
  isStalled: boolean;
  daysAgo: number | null;
  effectiveProgress: number;
  isAging: boolean;
  isPastTwiceSla: boolean;
}

function deriveDwell(
  task: Task,
  isOverrideStalled: boolean | undefined,
  slaDays: number | undefined,
): DwellFacts {
  const { text: stampText, isStalled: derivedStalled, daysAgo } = entryStamp(task);
  // Aging / dwell-time indicator (issue 192)
  const isAging = daysAgo !== null && slaDays !== undefined && daysAgo > slaDays;
  return {
    stampText,
    isStalled: isOverrideStalled ?? derivedStalled,
    daysAgo,
    // COMPLETE clamps display progress to 100% so the ring, the bottom strip,
    // and the aria-label all reflect "done" regardless of the stored value.
    // The raw `task.progress` is still used for SPI math since SPI measures
    // actual delivered work against plan, not status.
    effectiveProgress: task.status === 'COMPLETE' ? 100 : task.progress,
    isAging,
    isPastTwiceSla: isAging && daysAgo > 2 * slaDays,
  };
}

/** EVM / cost chip visibility and the values behind them. */
interface EvmFacts {
  spi: number | null;
  spiBand: 'on_track' | 'at_risk' | 'behind' | null;
  cpi: number | null;
  showSpiChip: boolean;
  showCpiChip: boolean;
  showCostChip: boolean;
  evmShowsSpi: boolean;
  evmShowsCpi: boolean;
}

/**
 * EVM indicators (issue 185): SPI + its band are server-owned (issue 990 / API-first
 * issue 986) — the card renders them, it no longer re-derives earned%/planned% from
 * baseline dates in the browser. CPI stays sourced from the (currently unpopulated)
 * cost field until the cost model ships (issue 73).
 */
function deriveEvm(task: Task, showEvm: EvmMode, showCost: boolean, isCompact: boolean): EvmFacts {
  const spi = task.spi ?? null;
  const cpi = task.cpi ?? null;
  const evmShowsSpi = showEvm === 'spi' || showEvm === 'both';
  const evmShowsCpi = showEvm === 'cpi' || showEvm === 'both';
  return {
    spi,
    spiBand: task.spiBand ?? null,
    cpi,
    showSpiChip: !isCompact && evmShowsSpi && spi !== null,
    showCpiChip: !isCompact && evmShowsCpi && cpi !== null,
    // Cost chip (issue 189): shown when toggle is on and task has BAC data.
    showCostChip: showCost && !isCompact && task.budgetAtCompletion != null,
    evmShowsSpi,
    evmShowsCpi,
  };
}

/** Dependency / risk / float signals that feed the in-flow chips and the classifier. */
interface SignalFacts {
  predecessorCount: number;
  isBlocked: boolean;
  linkedRisksCount: number;
  linkedRisksMaxSeverity: number | null;
  showChain: boolean;
  showRisk: boolean;
  hasFloatData: boolean;
  floatDays: number;
}

function deriveSignals(task: Task, isScheduled: boolean): SignalFacts {
  const predecessorCount = task.predecessorCount ?? 0;
  const linkedRisksCount = task.linkedRisksCount ?? 0;
  const linkedRisksMaxSeverity = task.linkedRisksMaxSeverity ?? null;
  // CPM produces float for every dated task, including backlog ideas the PM
  // hasn't committed to (issue 332) — suppress it until the task is scheduled so
  // the worst-offender classifier reads null, not garbage.
  const hasFloatData =
    isScheduled && (task.isCritical || (task.totalFloat !== undefined && task.totalFloat !== null));
  return {
    predecessorCount,
    isBlocked: task.isBlocked ?? false,
    linkedRisksCount,
    linkedRisksMaxSeverity,
    showChain: predecessorCount > 0,
    showRisk: linkedRisksCount > 0 && linkedRisksMaxSeverity !== null && linkedRisksMaxSeverity > 0,
    hasFloatData,
    // CP tasks have 0d float by definition; otherwise show totalFloat when set.
    floatDays: task.isCritical ? 0 : (task.totalFloat as number),
  };
}

/**
 * Shared card container class. A read-only (closed-sprint) card drops the grab
 * cursor — it's still clickable to open detail, just not draggable (issue 1141).
 */
function cardContainerClass(opts: {
  readOnly: boolean;
  showCriticalState: boolean;
  isIdea: boolean;
  isKeyboardFocused: boolean;
  isDimmed: boolean;
  isFilteredOut: boolean;
  isPending: boolean;
}): string {
  const { showCriticalState, isIdea, isDimmed, isFilteredOut, isPending } = opts;
  let borderClass = 'border-neutral-border';
  if (showCriticalState) borderClass = 'border-semantic-critical border-2';
  else if (isIdea) borderClass = 'border-dashed border-neutral-border';

  // A facet-filtered-out card dims harder than a dep/search dim and wins over
  // both (issue 1091) — it's the strongest "not part of your current view" cue.
  let dimClass = '';
  if (isFilteredOut) dimClass = 'opacity-30 pointer-events-none';
  else if (isDimmed) dimClass = 'opacity-40';

  return [
    'bg-neutral-surface border rounded-card relative group',
    opts.readOnly ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
    'focus:ring-2 focus:ring-brand-primary focus:ring-offset-1',
    // v2 fluidity (ADR-0126): subtle hover-lift, no shadow (rule 1) — the card's
    // own border supplies the edge. Single multi-prop transition so opacity
    // (dim states) and the lift share one declaration; lift is motion-safe (rule 70).
    'transition-[opacity,transform] duration-fast ease-brand motion-safe:hover:-translate-y-px',
    borderClass,
    opts.isKeyboardFocused
      ? 'ring-2 ring-brand-primary ring-offset-1 ring-offset-neutral-surface-sunken'
      : '',
    dimClass,
    // Pending injections are de-emphasized (ADR-0102 §6) — but not as faint as
    // a dimmed/dep-highlight card, so the chip + accept tick stay legible.
    isPending && !isDimmed && !isFilteredOut ? 'opacity-70' : '',
  ].join(' ');
}

/**
 * Apply the card's optional-prop defaults in one place so the derivation below
 * reads plain values. Kept separate from `useBoardCardView` because a dozen
 * destructuring defaults is a dozen branches on the complexity metric for zero
 * conceptual weight.
 */
function withCardDefaults(props: BoardCardProps) {
  return {
    ...props,
    density: props.density ?? ('comfortable' as BoardDensity),
    isKeyboardFocused: props.isKeyboardFocused ?? false,
    isDimmed: props.isDimmed ?? false,
    isFilteredOut: props.isFilteredOut ?? false,
    showEvm: props.showEvm ?? ('off' as EvmMode),
    showCost: props.showCost ?? false,
    readOnly: props.readOnly ?? false,
  };
}

/** Everything `BoardCard`'s render branches read, derived once per render. */
export interface BoardCardView extends ColumnContext, DwellFacts, EvmFacts, SignalFacts {
  /** Iteration vocabulary ("sprint"/"iteration") for scope-injection copy. */
  itl: ReturnType<typeof useIterationLabel>;
  estimationScale: EstimationScale;
  isIdea: boolean;
  isCompact: boolean;
  isDetailed: boolean;
  isScheduled: boolean;
  isPending: boolean;
  showCriticalState: boolean;
  pendingExplainer: string;
  isPendingSync: boolean;
  cardSignal: CardSignal | null;
  /** Stable id so the health badge's aria-controls points at its disclosure peek. */
  peekId: string;
  containerClass: string;
}

/**
 * Derive every fact the card's three render branches (overlay / compact /
 * comfortable-detailed) need, so each branch stays pure presentation.
 *
 * Extracted from `BoardCardImpl` for #2081 — no behavior change; the ordering of
 * the hook calls below is the same as the original inline derivation, which
 * keeps the rules of hooks satisfied across all render branches.
 */
export function useBoardCardView(props: BoardCardProps): BoardCardView {
  const {
    task,
    isStalled: isOverrideStalled,
    columns,
    density,
    isKeyboardFocused,
    isDimmed,
    isFilteredOut,
    showEvm,
    showCost,
    readOnly,
  } = withCardDefaults(props);

  const itl = useIterationLabel();
  // Resolved estimation scale for the point badge (ADR-0510, #2027). useProject
  // shares the ['project', id] react-query cache, so every card reads it without a
  // new request; Fibonacci until the project detail resolves.
  const estimationScale =
    useProject(useProjectId()).data?.effective_estimation_scale ?? 'fibonacci';
  // ADR-0220: does this card have a status move queued offline (IndexedDB) that
  // has not yet flushed? Subscribed from the board outbox store so the badge
  // appears/clears reactively without prop-drilling through the board grid.
  const isPendingSync = useIsCardPendingSync(task.id);

  const columnContext = deriveColumnContext(columns, task);
  const dwell = deriveDwell(task, isOverrideStalled, columnContext.slaDays);
  const isCompact = density === 'compact';
  const evm = deriveEvm(task, showEvm, showCost, isCompact);
  // CPM marks every dated task with isCritical/totalFloat, including backlog
  // ideas the PM hasn't committed to. Suppress the red CP signal and float
  // chip until the task is scheduled (plannedStart set or in a sprint) — see
  // issue 332. The CPM data is still passed through unchanged; only the
  // display gates on commitment.
  const isScheduled = isTaskScheduled(task);
  const signals = deriveSignals(task, isScheduled);
  // ADR-0102: a pending-acceptance injection is visible but not yet committed.
  // The card is muted and — per the ux-design — the red CP signal is suppressed
  // while pending (the task isn't part of the commitment, so its critical-path
  // status is not yet a team concern; it reappears on accept). The neutral
  // PendingAcceptanceChip carries the read-state instead.
  const isPending = task.sprintPending === true;
  const showCriticalState = task.isCritical && isScheduled && !isPending;
  const isIdea = (task.readiness ?? 'estimated') === 'idea';

  return {
    ...columnContext,
    ...dwell,
    ...evm,
    ...signals,
    itl,
    estimationScale,
    isIdea,
    isCompact,
    isDetailed: density === 'detailed',
    isScheduled,
    isPending,
    showCriticalState,
    // #1472: the pending chip becomes a tap-to-explain disclosure on the board so a
    // plain Member (who has no reachable accept/reject) can understand the signal.
    // Role-neutral, iteration-label-aware copy built in the shared helper.
    pendingExplainer: pendingAcceptanceExplainer(itl.lower),
    isPendingSync,
    // Worst-offender signal (issue 1305, ADR-0191 §4): the single highest-severity
    // health signal, shown as one primary badge so the card stays calm. EVM tiers
    // feed in only when the board's EVM toggle is on, so the badge never
    // contradicts a hidden chip.
    cardSignal: classifyCardSignal({
      isBlocked: signals.isBlocked,
      predecessorCount: signals.predecessorCount,
      isAging: dwell.isAging,
      isStalled: dwell.isStalled,
      isPastTwiceSla: dwell.isPastTwiceSla,
      daysAgo: dwell.daysAgo,
      showCriticalState,
      floatDays: signals.hasFloatData ? signals.floatDays : null,
      spiBand: evm.evmShowsSpi ? evm.spiBand : null,
      cpi: evm.evmShowsCpi ? evm.cpi : null,
    }),
    peekId: `card-peek-${task.id}`,
    containerClass: cardContainerClass({
      readOnly,
      showCriticalState,
      isIdea,
      isKeyboardFocused,
      isDimmed,
      isFilteredOut,
      isPending,
    }),
  };
}
